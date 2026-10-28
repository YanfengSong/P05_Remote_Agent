import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { assertAccessiblePath } from "../security.js";
import {
  FILE_CONTRACT_VERSION,
  READ_LIMITS,
  isOutcomeFailure,
  outcomeFor as fixedOutcomeFor,
  type Outcome,
  type ReadBatch,
  type ReadErrorCode,
  type ReadItem,
  type ReadRequest,
  type ReadSlice
} from "./file-contracts.js";
import { toolResultBytes } from "./result-budget.js";
import { FileIoError, readBoundedSnapshot } from "./file-io.js";
import { selectLineWindow } from "./text-lines.js";

export class ReadRangeError extends Error {
  readonly code: ReadErrorCode;
  readonly sha256?: string;
  readonly totalLines?: number;

  constructor(
    code: ReadErrorCode,
    message: string,
    details: { sha256?: string; totalLines?: number } = {}
  ) {
    super(message);
    this.name = "ReadRangeError";
    this.code = code;
    if (details.sha256 !== undefined) this.sha256 = details.sha256;
    if (details.totalLines !== undefined) this.totalLines = details.totalLines;
  }
}

export type ReadManyResult = {
  result: ReadBatch;
  contentText: string;
};

/**
 * The configured limit may be smaller than the contract hard cap, never larger.
 * Invalid local limits fail closed instead of degrading to an unbounded read.
 */
export function resolveReadLimit(configured: number = config.maxReadBytes): number {
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new ReadRangeError(
      "READ_LIMIT_INVALID",
      "The server read limit is invalid; reading is disabled."
    );
  }
  return Math.min(configured, READ_LIMITS.maxFileBytes);
}

/**
 * The configured range cap may exceed the snapshot cap, but never the contract
 * hard cap for streamed reads.
 */
export function resolveRangeLimit(configured: number = config.maxRangeReadBytes): number {
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new ReadRangeError(
      "READ_LIMIT_INVALID",
      "The server range read limit is invalid; reading is disabled."
    );
  }
  return Math.min(configured, READ_LIMITS.maxRangeFileBytes);
}

/**
 * Split on LF while preserving CRLF exactly. A trailing newline terminates the last
 * line and does not create an extra empty line; an empty file has no lines.
 */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function appearsBinary(buffer: Buffer): boolean {
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) suspicious += 1;
  }
  return buffer.length > 0 && suspicious > 8 && suspicious / buffer.length > 0.01;
}

function decodeUtf8Strict(buffer: Buffer): string {
  if (appearsBinary(buffer)) {
    throw new ReadRangeError("BINARY_FILE", "File appears to be binary.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new ReadRangeError("INVALID_UTF8", "File is not valid UTF-8 text.");
  }

  // The BOM remains part of the hashed raw bytes but is not displayed as content.
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function mapFileSystemError(error: unknown): ReadRangeError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new ReadRangeError("NOT_FOUND", "File not found.");
    case "EISDIR":
      return new ReadRangeError("IS_DIRECTORY", "Path is a directory, not a file.");
    case "EACCES":
    case "EPERM":
      return new ReadRangeError("ACCESS_DENIED", "Access denied.");
    default:
      return new ReadRangeError("READ_FAILED", "Could not read the file.");
  }
}

async function readSnapshotFromHandle(handle: FileHandle, limit: number): Promise<Buffer> {
  try {
    return (await readBoundedSnapshot(handle, limit)).bytes;
  } catch (error) {
    if (error instanceof FileIoError) {
      switch (error.code) {
        case "INVALID_LIMIT":
          throw new ReadRangeError("READ_LIMIT_INVALID", "The server read limit is invalid.");
        case "IS_DIRECTORY":
          throw new ReadRangeError("IS_DIRECTORY", "Path is a directory, not a file.");
        case "NOT_REGULAR_FILE":
          throw new ReadRangeError("NOT_FILE", "Path is not a regular file.");
        case "TOO_LARGE":
          throw new ReadRangeError(
            "READ_TOO_LARGE",
            `File exceeds the read limit of ${limit} bytes.`
          );
        case "FILE_UNSTABLE":
          throw new ReadRangeError(
            "READ_UNSTABLE",
            "File changed while it was being read; retry."
          );
        default:
          throw new ReadRangeError("READ_FAILED", "Could not read the file.");
      }
    }
    throw mapFileSystemError(error);
  }
}

function sliceFromBuffer(buffer: Buffer, request: ReadRequest): ReadSlice {
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (
    request.expected_sha256 !== undefined &&
    digest.toLowerCase() !== request.expected_sha256.toLowerCase()
  ) {
    throw new ReadRangeError(
      "STALE_REVISION",
      "File changed since review; re-read before retrying.",
      { sha256: digest }
    );
  }

  const text = decodeUtf8Strict(buffer);
  const window = selectLineWindow(text, request.offset, request.limit);
  const totalLines = window.totalLines;

  if (request.offset > totalLines) {
    throw new ReadRangeError(
      "OFFSET_OUT_OF_RANGE",
      "offset is past the end of the file.",
      { sha256: digest, totalLines }
    );
  }

  const end = request.offset + window.returnedLines;
  const complete = end >= totalLines;

  return {
    path: request.path,
    sha256: digest,
    totalLines,
    offset: request.offset,
    returnedLines: window.returnedLines,
    lineStart: request.offset + 1,
    lineEnd: end,
    text: window.text,
    complete,
    ...(complete ? {} : { nextOffset: end })
  };
}

/**
 * Stream a file larger than the in-memory snapshot limit. Only the requested
 * line window is retained; the full raw stream is hashed and UTF-8 checked.
 */
async function readStreamedRange(
  handle: FileHandle,
  before: BigIntStats,
  request: ReadRequest
): Promise<ReadSlice> {
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ReadRangeError("READ_TOO_LARGE", "File size is outside the supported range.");
  }

  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let lineIndex = 0;
  let sawBytes = false;
  let lastByteWasLf = false;
  let sampledBytes = 0;

  while (position < size) {
    let bytesRead: number;
    try {
      bytesRead = (await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position
      )).bytesRead;
    } catch (error) {
      throw mapFileSystemError(error);
    }
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
      throw new ReadRangeError(
        "READ_UNSTABLE",
        "File changed while it was being read; retry."
      );
    }

    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) {
      throw new ReadRangeError("BINARY_FILE", "File appears to be binary.");
    }
    if (sampledBytes < 64 * 1024) {
      const sample = chunk.subarray(0, Math.min(chunk.length, 64 * 1024 - sampledBytes));
      if (appearsBinary(sample)) {
        throw new ReadRangeError("BINARY_FILE", "File appears to be binary.");
      }
      sampledBytes += sample.length;
    }

    hash.update(chunk);
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      throw new ReadRangeError("INVALID_UTF8", "File is not valid UTF-8 text.");
    }

    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (
        lineIndex >= request.offset &&
        lineIndex < request.offset + request.limit
      ) {
        chunks.push(Buffer.from(chunk.subarray(start, index + 1)));
      }
      lineIndex += 1;
      start = index + 1;
    }
    if (
      start < chunk.length &&
      lineIndex >= request.offset &&
      lineIndex < request.offset + request.limit
    ) {
      chunks.push(Buffer.from(chunk.subarray(start)));
    }

    sawBytes = true;
    lastByteWasLf = chunk[chunk.length - 1] === 0x0a;
    position += bytesRead;
  }

  try {
    decoder.decode();
  } catch {
    throw new ReadRangeError("INVALID_UTF8", "File is not valid UTF-8 text.");
  }

  const after = await handle.stat({ bigint: true });
  const unstable =
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    after.dev !== before.dev ||
    after.ino !== before.ino;
  if (unstable) {
    throw new ReadRangeError(
      "READ_UNSTABLE",
      "File changed while it was being read; retry."
    );
  }

  const digest = hash.digest("hex");
  if (
    request.expected_sha256 !== undefined &&
    digest.toLowerCase() !== request.expected_sha256.toLowerCase()
  ) {
    throw new ReadRangeError(
      "STALE_REVISION",
      "File changed since review; re-read before retrying.",
      { sha256: digest }
    );
  }

  const totalLines = sawBytes ? lineIndex + (lastByteWasLf ? 0 : 1) : 0;
  if (request.offset > totalLines) {
    throw new ReadRangeError(
      "OFFSET_OUT_OF_RANGE",
      "offset is past the end of the file.",
      { sha256: digest, totalLines }
    );
  }

  const returnedLines = Math.min(
    Math.max(0, totalLines - request.offset),
    request.limit
  );
  const end = request.offset + returnedLines;
  const complete = end >= totalLines;
  let text = Buffer.concat(chunks).toString("utf8");
  if (request.offset === 0 && text.startsWith("\uFEFF")) text = text.slice(1);

  return {
    path: request.path,
    sha256: digest,
    totalLines,
    offset: request.offset,
    returnedLines,
    lineStart: request.offset + 1,
    lineEnd: end,
    text,
    complete,
    ...(complete ? {} : { nextOffset: end })
  };
}

/**
 * Read one line range. Files within the configured snapshot limit use the strict
 * buffered path; larger files stream through a bounded buffer and retain only the
 * requested lines.
 */
export async function readRange(root: string, request: ReadRequest): Promise<ReadSlice> {
  const snapshotLimit = resolveReadLimit();
  const rangeLimit = Math.max(snapshotLimit, resolveRangeLimit());

  let safePath: string;
  try {
    // Reuse the existing workspace/protected-path/link policy. Its documented
    // hard-link and TOCTOU limitations are unchanged by this read contract.
    safePath = await assertAccessiblePath(request.path, "read", root, root);
  } catch {
    throw new ReadRangeError("PATH_REFUSED", "Path is not allowed for reading.");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(safePath, "r");
  } catch (error) {
    throw mapFileSystemError(error);
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (before.isDirectory()) {
      throw new ReadRangeError("IS_DIRECTORY", "Path is a directory, not a file.");
    }
    if (!before.isFile()) {
      throw new ReadRangeError("NOT_FILE", "Path is not a regular file.");
    }
    if (before.size > BigInt(rangeLimit)) {
      throw new ReadRangeError(
        "READ_TOO_LARGE",
        `File exceeds the range read limit of ${rangeLimit} bytes.`
      );
    }

    if (before.size <= BigInt(snapshotLimit)) {
      const buffer = await readSnapshotFromHandle(handle, snapshotLimit);
      return sliceFromBuffer(buffer, request);
    }
    return await readStreamedRange(handle, before, request);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function successItem(index: number, request: ReadRequest, slice: ReadSlice): ReadItem {
  return {
    index,
    path: request.path,
    ok: true,
    bytes: Buffer.byteLength(slice.text, "utf8"),
    sha256: slice.sha256,
    totalLines: slice.totalLines,
    offset: slice.offset,
    returnedLines: slice.returnedLines,
    ...(slice.returnedLines > 0
      ? { lineStart: slice.lineStart, lineEnd: slice.lineEnd }
      : {}),
    text: slice.text,
    complete: slice.complete,
    ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {})
  };
}

function errorItem(index: number, filePath: string, error: unknown): ReadItem {
  const known = error instanceof ReadRangeError ? error : undefined;
  return {
    index,
    path: filePath,
    ok: false,
    bytes: 0,
    ...(known?.sha256 ? { sha256: known.sha256 } : {}),
    ...(known?.totalLines !== undefined ? { totalLines: known.totalLines } : {}),
    errorCode: known?.code ?? "READ_FAILED",
    error: known?.message ?? "Could not read the file."
  };
}

function lineTooLargeItem(item: ReadItem): ReadItem {
  const {
    text: _text,
    returnedLines: _returnedLines,
    lineStart: _lineStart,
    lineEnd: _lineEnd,
    complete: _complete,
    nextOffset: _nextOffset,
    ...metadata
  } = item;

  return {
    ...metadata,
    ok: false,
    bytes: 0,
    errorCode: "LINE_TOO_LARGE",
    error:
      "The requested line is longer than max_bytes. Increase max_bytes (up to 256 KiB) or use a byte-chunk reader; a smaller line range cannot split one line."
  };
}

function truncatedItem(
  item: ReadItem,
  slice: ReadSlice,
  lines: readonly string[],
  count: number
): ReadItem {
  const text = lines.slice(0, count).join("");
  return {
    ...item,
    bytes: Buffer.byteLength(text, "utf8"),
    returnedLines: count,
    lineStart: slice.offset + 1,
    lineEnd: slice.offset + count,
    text,
    complete: false,
    nextOffset: slice.offset + count
  };
}

function outcomeFor(items: readonly ReadItem[], pendingIndexes: readonly number[]): Outcome {
  const failures = items.filter((item) => !item.ok);
  if (failures.length > 0) {
    const codes = failures.map((item) => item.errorCode ?? "READ_FAILED");
    const uniqueCodes = [...new Set(codes)];
    if (uniqueCodes.length === 1) {
      return fixedOutcomeFor(uniqueCodes[0]!);
    }

    const retryRank = { safe: 0, after_refresh: 1, never_automatic: 2 } as const;
    const retry = uniqueCodes
      .map((code) => fixedOutcomeFor(code).retry)
      .reduce(
        (left, right) => retryRank[left] >= retryRank[right] ? left : right,
        "safe" as const
      );
    const hasSuccess = items.some((item) => item.ok);
    return {
      status: hasSuccess ? "partial" : "error",
      effectState: "none",
      retry,
      code: hasSuccess ? "READ_PARTIAL" : "READ_FAILED",
      nextAction: "Inspect failed indexes; do not automatically retry rejected or conflicting reads."
    };
  }

  if (pendingIndexes.length > 0) {
    return fixedOutcomeFor("READ_TRUNCATED");
  }
  if (items.some((item) => item.ok && item.complete === false)) {
    return fixedOutcomeFor("READ_TRUNCATED");
  }
  return fixedOutcomeFor("READ_COMPLETE");
}

function renderReadContent(result: ReadBatch): string {
  const parts: string[] = [
    "V2 fs_read_many: " +
      result.outcome.status +
      " (" +
      result.outcome.code +
      "), returned=" +
      result.successCount +
      ", failed=" +
      result.failureCount +
      ", pending=" +
      result.pendingIndexes.length +
      ", max_bytes=" +
      result.max_bytes +
      "."
  ];

  for (const item of result.files) {
    if (item.ok) {
      const range =
        item.returnedLines !== undefined && item.returnedLines > 0
          ? "lines " + item.lineStart + "-" + item.lineEnd + " of " + item.totalLines
          : "no lines (totalLines=" + item.totalLines + ")";
      parts.push(
        "--- " +
          item.path +
          " | " +
          range +
          " | offset=" +
          item.offset +
          " | returned=" +
          item.returnedLines +
          " | complete=" +
          item.complete +
          " | sha256=" +
          item.sha256 +
          (item.nextOffset !== undefined ? " | nextOffset=" + item.nextOffset : "") +
          " ---"
      );
      if (item.text !== undefined && item.text.length > 0) parts.push(item.text);
    } else {
      parts.push(
        "--- " +
          item.path +
          " | ERROR " +
          (item.errorCode ?? "READ_FAILED") +
          (item.sha256 ? " | sha256=" + item.sha256 : "") +
          " ---"
      );
      parts.push(item.error ?? "Could not read the file.");
      if (item.totalLines !== undefined) parts.push("totalLines=" + item.totalLines);
    }
  }

  if (result.pendingIndexes.length > 0) {
    parts.push("pendingIndexes: [" + result.pendingIndexes.join(", ") + "]");
  }
  parts.push(
    "outcome: " +
      result.outcome.status +
      "/" +
      result.outcome.effectState +
      "/" +
      result.outcome.retry +
      " " +
      result.outcome.code +
      ". " +
      result.outcome.nextAction
  );

  return parts.join("\n");
}

function buildReadResult(
  items: readonly ReadItem[],
  pendingIndexes: readonly number[],
  maxBytes: number
): ReadManyResult {
  const successCount = items.reduce((total, item) => total + (item.ok ? 1 : 0), 0);
  const failureCount = items.length - successCount;
  const totalBytes = items.reduce(
    (total, item) => total + (item.ok ? item.bytes : 0),
    0
  );
  const result: ReadBatch = {
    contract_version: FILE_CONTRACT_VERSION,
    outcome: outcomeFor(items, pendingIndexes),
    max_bytes: maxBytes,
    files: [...items],
    pendingIndexes: [...pendingIndexes],
    totalBytes,
    successCount,
    failureCount
  };
  return { result, contentText: renderReadContent(result) };
}

function fits(result: ReadManyResult, maxBytes: number): boolean {
  return toolResultBytes(
    result.result,
    result.contentText,
    isOutcomeFailure(result.result.outcome)
  ) <= maxBytes;
}

function fitByLines(
  baseItems: readonly ReadItem[],
  item: ReadItem,
  slice: ReadSlice,
  pendingIndexes: readonly number[],
  maxBytes: number
): ReadItem | undefined {
  const lines = splitLines(slice.text);
  if (lines.length <= 1) return undefined;

  let low = 1;
  let high = lines.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncatedItem(item, slice, lines, middle);
    if (fits(buildReadResult([...baseItems, candidate], pendingIndexes, maxBytes), maxBytes)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best > 0 ? truncatedItem(item, slice, lines, best) : undefined;
}

function tailIndexes(total: number, start: number): number[] {
  return Array.from({ length: Math.max(0, total - start) }, (_, offset) => start + offset);
}

function normalizeIndexes(indexes: readonly number[]): number[] {
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function budgetFailure(pendingIndexes: readonly number[], maxBytes: number): ReadManyResult {
  const pending = normalizeIndexes(pendingIndexes);
  const result: ReadBatch = {
    contract_version: FILE_CONTRACT_VERSION,
    outcome: fixedOutcomeFor("RESULT_BUDGET_TOO_SMALL"),
    max_bytes: maxBytes,
    files: [],
    pendingIndexes: pending,
    totalBytes: 0,
    successCount: 0,
    failureCount: 0
  };
  const contentText =
    "V2 fs_read_many rejected: RESULT_BUDGET_TOO_SMALL; no request metadata fits within max_bytes=" +
    maxBytes +
    ". pendingIndexes: [" +
    pending.join(", ") +
    "].";
  const response: ReadManyResult = { result, contentText };
  if (!fits(response, maxBytes)) {
    throw new ReadRangeError(
      "RESULT_BUDGET_TOO_SMALL",
      "The response budget is too small for the error envelope."
    );
  }
  return response;
}

function trimLastSuccessItem(
  items: readonly ReadItem[],
  pendingIndexes: readonly number[],
  maxBytes: number
): ReadItem | undefined {
  const last = items[items.length - 1];
  if (!last?.ok || typeof last.text !== "string") return undefined;

  const lines = splitLines(last.text);
  if (lines.length <= 1) return undefined;

  const offset = last.offset ?? 0;
  let low = 1;
  let high = lines.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = lines.slice(0, middle).join("");
    const candidate: ReadItem = {
      ...last,
      bytes: Buffer.byteLength(text, "utf8"),
      text,
      returnedLines: middle,
      lineEnd: offset + middle,
      complete: false,
      nextOffset: offset + middle
    };
    const result = buildReadResult(
      [...items.slice(0, -1), candidate],
      pendingIndexes,
      maxBytes
    );
    if (fits(result, maxBytes)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best === 0) return undefined;
  const text = lines.slice(0, best).join("");
  return {
    ...last,
    bytes: Buffer.byteLength(text, "utf8"),
    text,
    returnedLines: best,
    lineEnd: offset + best,
    complete: false,
    nextOffset: offset + best
  };
}

/**
 * Single output exit for range reads. The exact final object (including isError and
 * pending metadata) is measured. When over budget, trim the last successful range by
 * whole lines, then move whole items to pending; never drop a processed index silently.
 */
function finalizeReadResult(
  items: readonly ReadItem[],
  pendingIndexes: readonly number[],
  maxBytes: number
): ReadManyResult {
  let currentItems = [...items];
  let currentPending = normalizeIndexes(pendingIndexes);

  for (;;) {
    if (currentItems.length === 0) return budgetFailure(currentPending, maxBytes);
    const candidate = buildReadResult(currentItems, currentPending, maxBytes);
    if (fits(candidate, maxBytes)) return candidate;

    const trimmed = trimLastSuccessItem(currentItems, currentPending, maxBytes);
    if (trimmed) {
      currentItems = [...currentItems.slice(0, -1), trimmed];
      continue;
    }

    const removed = currentItems[currentItems.length - 1]!;
    currentItems = currentItems.slice(0, -1);
    currentPending = normalizeIndexes([...currentPending, removed.index]);
  }
}

/**
 * Read independent ranges in request order. A per-file failure never throws; it becomes
 * one item and later files are still attempted. Once the response budget is exhausted,
 * the current request is either trimmed by whole lines (with nextOffset) or left in
 * pendingIndexes, so every truncation has a real way forward.
 */
export async function readManyRanges(
  root: string,
  requests: readonly ReadRequest[],
  maxBytes: number
): Promise<ReadManyResult> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < READ_LIMITS.minMaxBytes ||
    maxBytes > READ_LIMITS.maxMaxBytes
  ) {
    throw new ReadRangeError(
      "READ_LIMIT_INVALID",
      "max_bytes is outside the supported range."
    );
  }

  const files: ReadItem[] = [];
  const pendingIndexes: number[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    let item: ReadItem;
    let slice: ReadSlice | undefined;

    try {
      slice = await readRange(root, request);
      item = successItem(index, request, slice);
    } catch (error) {
      item = errorItem(index, request.path, error);
    }

    if (!item.ok) {
      const candidate = buildReadResult([...files, item], [], maxBytes);
      if (fits(candidate, maxBytes)) {
        files.push(item);
        continue;
      }
      if (files.length === 0) {
        return finalizeReadResult([], tailIndexes(requests.length, 0), maxBytes);
      }
      pendingIndexes.push(...tailIndexes(requests.length, index));
      break;
    }

    const full = buildReadResult([...files, item], [], maxBytes);
    if (fits(full, maxBytes)) {
      files.push(item);
      continue;
    }

    const later = tailIndexes(requests.length, index + 1);
    const trimmed = slice
      ? fitByLines(files, item, slice, later, maxBytes)
      : undefined;
    if (trimmed) {
      files.push(trimmed);
      pendingIndexes.push(...later);
      break;
    }

    if (files.length === 0) {
      if ((item.returnedLines ?? 0) > 0) {
        const lineError = lineTooLargeItem(item);
        const errorCandidate = buildReadResult([lineError], [], maxBytes);
        if (fits(errorCandidate, maxBytes)) {
          files.push(lineError);
          continue;
        }
      }
      return finalizeReadResult([], tailIndexes(requests.length, 0), maxBytes);
    }

    pendingIndexes.push(...tailIndexes(requests.length, index));
    break;
  }

  return finalizeReadResult(files, pendingIndexes, maxBytes);
}
