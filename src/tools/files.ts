import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { assertAccessiblePath, protectionReason } from "../security.js";
import type {
  Outcome,
  PatchBatchResult,
  PatchBatchStatus,
  PatchDiffSummary,
  PatchFileResult,
  SearchCoverage,
  SearchStopReason,
  TextEdit
} from "./file-contracts.js";
import { FILE_CONTRACT_VERSION, PATCH_LIMITS, outcomeFor } from "./file-contracts.js";
import { applyEditsToText, PatchEditError, summarizeEdits } from "./patch-edits.js";
import { canonicalWriteKey, withWriteLocks } from "./file-write-lock.js";
import {
  FileIoError,
  readBoundedSnapshot,
  validatePositiveFileLimit,
  writeAllAtStart
} from "./file-io.js";

/**
 * fs errors are returned to a remote client, so they are mapped to short messages: the
 * raw text carries the resolved absolute path, which would leak the working directory.
 */
function describeError(error: unknown, fallback: string): Error {
  const code = (error as { code?: string })?.code;
  if (code === "ENOENT") return new Error("Not found.");
  if (code === "EISDIR") return new Error("Path is a directory, not a file.");
  if (code === "ENOTDIR") return new Error("A path component is not a directory.");
  if (code === "EACCES" || code === "EPERM") return new Error("Access denied.");
  return new Error(fallback);
}

function describeFileIoReadError(error: unknown, limit: number): Error {
  if (error instanceof FileIoError) {
    switch (error.code) {
      case "INVALID_LIMIT":
        return new Error("The server read limit is invalid; reading is disabled.");
      case "IS_DIRECTORY":
        return new Error("Path is not a file.");
      case "NOT_REGULAR_FILE":
        return new Error("Path is not a file.");
      case "TOO_LARGE":
        return new Error(`File exceeds maxReadBytes (${limit}).`);
      default:
        return new Error("Could not read the file.");
    }
  }
  return describeError(error, "Could not read the file.");
}

function fileWriteLimit(): number {
  try {
    return validatePositiveFileLimit(config.maxWriteBytes, "maxWriteBytes");
  } catch {
    throw new Error("The server write limit is invalid; writing is disabled.");
  }
}

export async function readTextFile(filePath: string, baseDir = config.defaultCwd): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "read", baseDir, baseDir);
  let limit: number;
  try {
    limit = validatePositiveFileLimit(config.maxReadBytes, "maxReadBytes");
  } catch {
    throw new Error("The server read limit is invalid; reading is disabled.");
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(safePath, "r");
  } catch (error) {
    throw describeError(error, "Could not read the file.");
  }

  try {
    const snapshot = await readBoundedSnapshot(handle, limit);
    return snapshot.bytes.toString("utf8");
  } catch (error) {
    throw describeFileIoReadError(error, limit);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Returns the byte count only, never the path: the caller echoes its own input back to
 * the remote instead. A successful response used to carry `safePath`, which disclosed
 * the resolved absolute path (and with it the working directory) whenever the caller
 * asked for a relative path, or a junction was resolved to its target.
 */
export async function writeTextFile(
  filePath: string,
  content: string,
  baseDir = config.defaultCwd
): Promise<{ bytes: number }> {
  const safePath = await assertAccessiblePath(filePath, "write", baseDir, baseDir);
  const maxWriteBytes = fileWriteLimit();
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxWriteBytes) {
    throw new Error(`Content exceeds maxWriteBytes (${maxWriteBytes}).`);
  }

  const lockKey = await canonicalWriteKey(safePath);
  return withWriteLocks([lockKey], async () => {
    try {
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, "utf8");
    } catch (error) {
      throw describeError(error, "Could not write the file.");
    }
    return { bytes };
  });
}

/**
 * Entry names only — the caller supplied the directory, so echoing its own string back
 * discloses nothing, while a resolved path would.
 */
export async function listDirectory(dirPath: string, baseDir = config.defaultCwd): Promise<string[]> {
  const safePath = await assertAccessiblePath(dirPath, "read", baseDir, baseDir);
  try {
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    return entries.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
  } catch (error) {
    throw describeError(error, "Could not list the directory.");
  }
}

export type PatchTextResult = {
  bytes: number;
  sha256: string;
};

/**
 * Optimistic-concurrency text patch. The caller must prove which file version it reviewed
 * with expectedSha256, and oldText must occur exactly once. This prevents blind overwrite
 * and ambiguous multi-site replacement.
 */
export async function patchTextFile(
  filePath: string,
  expectedSha256: string,
  oldText: string,
  newText: string,
  baseDir = config.defaultCwd
): Promise<PatchTextResult> {
  const safePath = await assertAccessiblePath(filePath, "write", baseDir, baseDir);
  const maxWriteBytes = fileWriteLimit();
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("expected_sha256 must be a 64-character hexadecimal SHA-256.");
  }
  if (oldText.length === 0) throw new Error("old_text must not be empty.");

  const lockKey = await canonicalWriteKey(safePath);
  return withWriteLocks([lockKey], async () => {
    let current: string;
    try {
      current = await fs.readFile(safePath, "utf8");
    } catch (error) {
      throw describeError(error, "Could not read the file for patching.");
    }

    const actual = createHash("sha256").update(current, "utf8").digest("hex");
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`Patch refused: file changed since review (actual_sha256=${actual}). Re-read before retrying.`);
    }

    const first = current.indexOf(oldText);
    if (first < 0) throw new Error("Patch refused: old_text was not found.");
    if (current.indexOf(oldText, first + 1) >= 0) {
      throw new Error("Patch refused: old_text is ambiguous because it occurs more than once.");
    }

    const updated = current.slice(0, first) + newText + current.slice(first + oldText.length);
    const bytes = Buffer.byteLength(updated, "utf8");
    if (bytes > maxWriteBytes) {
      throw new Error(`Patched content exceeds maxWriteBytes (${maxWriteBytes}).`);
    }

    try {
      await fs.writeFile(safePath, updated, "utf8");
    } catch (error) {
      throw describeError(error, "Could not write the patched file.");
    }

    return {
      bytes,
      sha256: createHash("sha256").update(updated, "utf8").digest("hex")
    };
  });
}

export type BatchWriteInput = {
  path: string;
  content: string;
  expectedSha256?: string;
};

export type BatchPatchInput = {
  path: string;
  expectedSha256: string;
  oldText: string;
  newText: string;
};

export type BatchTextChangeResult = {
  path: string;
  bytes: number;
  sha256: string;
  created: boolean;
};

export type BatchMultiPatchInput = {
  path: string;
  expectedSha256: string;
  edits: TextEdit[];
};

/**
 * Test-only injection points. Production callers must omit hooks; the MCP
 * handlers never pass them.
 */
export type BatchCommitHooks = {
  afterWrite?: (path: string, index: number) => Promise<void> | void;
  beforeRollback?: (path: string, index: number) => Promise<void> | void;
};

export type PatchBatchV2Options = {
  dryRun?: boolean;
  hooks?: BatchCommitHooks;
};

class BatchOperationError extends Error {
  readonly code: string;
  readonly targetPath?: string;

  constructor(code: string, message: string, targetPath?: string) {
    super(message);
    this.name = "BatchOperationError";
    this.code = code;
    if (targetPath !== undefined) this.targetPath = targetPath;
  }
}

type BatchCommitFailure = {
  message: string;
  effect: "none" | "rolled_back" | "unknown";
  cause: string;
  causeCode: string;
  causePath?: string;
  rolledBack: string[];
  unknown: string[];
};

type BatchCommitOutcome =
  | { ok: true; results: BatchTextChangeResult[] }
  | { ok: false; failure: BatchCommitFailure };

type BatchOperation =
  | { kind: "write"; path: string; content: string; expectedSha256?: string }
  | {
      kind: "patch";
      path: string;
      expectedSha256: string;
      edits: TextEdit[];
      includeDiff?: boolean;
    };

type PreparedBatchOperation = {
  path: string;
  safePath: string;
  canonicalKey: string;
  existed: boolean;
  originalBuffer?: Buffer;
  originalSha256?: string;
  updatedBuffer: Buffer;
  sha256: string;
  diff?: PatchDiffSummary;
};

const MAX_BATCH_FILE_COUNT = PATCH_LIMITS.maxFiles;
const MAX_BATCH_WRITE_BYTES = PATCH_LIMITS.maxCandidateBytes;
const MAX_BATCH_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeBatchError(error: unknown, fallback: string): string {
  if (error instanceof BatchOperationError) return error.message;
  if (error instanceof FileIoError) return error.message;
  if ((error as { code?: string })?.code) {
    return describeError(error, fallback).message;
  }
  return error instanceof Error ? error.message : fallback;
}

function batchReadLimit(): number {
  try {
    return validatePositiveFileLimit(config.maxReadBytes, "maxReadBytes");
  } catch {
    throw new BatchOperationError(
      "READ_LIMIT_INVALID",
      "The server read limit is invalid; batch reading is disabled."
    );
  }
}

function batchWriteLimit(): number {
  try {
    return validatePositiveFileLimit(config.maxWriteBytes, "maxWriteBytes");
  } catch {
    throw new BatchOperationError(
      "WRITE_LIMIT_INVALID",
      "The server write limit is invalid; batch writing is disabled."
    );
  }
}

function decodeUtf8(buffer: Buffer, label: string): string {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new Error(label + " is not valid UTF-8 text.");
  }
  return text;
}

function batchSnapshotLimit(): number {
  return Math.min(batchReadLimit(), MAX_BATCH_SNAPSHOT_BYTES);
}

async function readHandleAtStart(
  handle: Awaited<ReturnType<typeof fs.open>>
): Promise<Buffer> {
  return (await readBoundedSnapshot(handle, batchSnapshotLimit())).bytes;
}

async function prepareBatchOperations(
  operations: BatchOperation[],
  baseDir: string
): Promise<PreparedBatchOperation[]> {
  if (operations.length < 1 || operations.length > MAX_BATCH_FILE_COUNT) {
    throw new BatchOperationError(
      "INVALID_REQUEST",
      "Batch operation requires 1 to " + MAX_BATCH_FILE_COUNT + " files."
    );
  }

  const seen = new Set<string>();
  const prepared: PreparedBatchOperation[] = [];
  let totalUpdatedBytes = 0;
  let totalSnapshotBytes = 0;
  const readLimit = batchReadLimit();
  const writeLimit = batchWriteLimit();

  for (const operation of operations) {
    let safePath: string;
    try {
      safePath = await assertAccessiblePath(operation.path, "write", baseDir, baseDir);
    } catch (error) {
      throw new BatchOperationError(
        "PATH_REFUSED",
        safeBatchError(error, "Write target is not allowed."),
        operation.path
      );
    }

    const parentPath = path.dirname(safePath);
    let parentStat;
    try {
      parentStat = await fs.stat(parentPath);
    } catch (error) {
      throw new BatchOperationError(
        "WRITE_FAILED",
        "Batch target " + operation.path + ": " +
          safeBatchError(error, "Parent directory is unavailable."),
        operation.path
      );
    }
    if (!parentStat.isDirectory()) {
      throw new BatchOperationError(
        "WRITE_FAILED",
        "Batch target " + operation.path + ": parent path is not a directory.",
        operation.path
      );
    }

    const canonicalKey = await canonicalWriteKey(safePath);
    if (seen.has(canonicalKey)) {
      throw new BatchOperationError(
        "DUPLICATE_TARGET",
        "Batch operation contains duplicate target paths: " + operation.path,
        operation.path
      );
    }
    seen.add(canonicalKey);

    let existed = true;
    let originalBuffer: Buffer | undefined;
    let originalText: string | undefined;
    let originalSha256: string | undefined;
    try {
      const stat = await fs.lstat(safePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new BatchOperationError(
          "SYMLINK_REFUSED",
          "Batch target " + operation.path + " is a symbolic link; refusing mutation.",
          operation.path
        );
      }
      if (!stat.isFile()) {
        throw new BatchOperationError(
          "NOT_REGULAR_FILE",
          "Batch target " + operation.path + " is not a regular file.",
          operation.path
        );
      }
      if (stat.nlink > 1n) {
        throw new BatchOperationError(
          "HARDLINK_REFUSED",
          "Batch target " + operation.path + " has multiple hard links; refusing mutation.",
          operation.path
        );
      }

      const remainingSnapshot = MAX_BATCH_SNAPSHOT_BYTES - totalSnapshotBytes;
      if (remainingSnapshot <= 0) {
        throw new BatchOperationError(
          "TOO_LARGE",
          "Batch rollback snapshot exceeds the 8 MiB safety limit."
        );
      }
      const perFileLimit = Math.min(readLimit, remainingSnapshot);
      if (stat.size > BigInt(perFileLimit)) {
        throw new BatchOperationError(
          "TOO_LARGE",
          "Batch target " + operation.path +
            " exceeds the remaining batch snapshot limit (" + perFileLimit + " bytes).",
          operation.path
        );
      }

      let handle: Awaited<ReturnType<typeof fs.open>>;
      handle = await fs.open(safePath, "r");
      try {
        const snapshot = await readBoundedSnapshot(handle, perFileLimit);
        if (snapshot.stat.dev !== stat.dev || snapshot.stat.ino !== stat.ino) {
          throw new BatchOperationError(
            "READ_UNSTABLE",
            "Batch target " + operation.path + " changed while it was being inspected; retry.",
            operation.path
          );
        }
        originalBuffer = snapshot.bytes;
      } finally {
        await handle.close().catch(() => undefined);
      }

      try {
        originalText = decodeUtf8(originalBuffer, "Batch target " + operation.path);
      } catch (error) {
        throw new BatchOperationError(
          "INVALID_UTF8",
          error instanceof Error ? error.message : "Batch target is not valid UTF-8 text.",
          operation.path
        );
      }
      originalSha256 = sha256Buffer(originalBuffer);
    } catch (error) {
      if (error instanceof BatchOperationError) throw error;
      if (error instanceof FileIoError) {
        const code = error.code === "TOO_LARGE"
          ? "TOO_LARGE"
          : error.code === "FILE_UNSTABLE"
            ? "READ_UNSTABLE"
            : error.code === "IS_DIRECTORY" || error.code === "NOT_REGULAR_FILE"
              ? "NOT_REGULAR_FILE"
              : error.code === "INVALID_LIMIT"
                ? "READ_LIMIT_INVALID"
                : "WRITE_FAILED";
        throw new BatchOperationError(
          code,
          "Batch target " + operation.path + ": " + error.message,
          operation.path
        );
      }
      if ((error as { code?: string })?.code === "ENOENT") {
        existed = false;
      } else {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": " +
            safeBatchError(error, "Could not inspect the target file."),
          operation.path
        );
      }
    }

    let updatedText: string;
    if (operation.kind === "write") {
      if (operation.expectedSha256 && !/^[a-f0-9]{64}$/i.test(operation.expectedSha256)) {
        throw new BatchOperationError(
          "INVALID_REQUEST",
          "expected_sha256 for " + operation.path + " must be a 64-character hexadecimal SHA-256.",
          operation.path
        );
      }
      if (existed && !operation.expectedSha256) {
        throw new BatchOperationError(
          "EXPECTED_SHA_REQUIRED",
          "Batch write refused for existing file " + operation.path +
            ": expected_sha256 is required. Re-read the file before replacing it.",
          operation.path
        );
      }
      if (existed && originalSha256?.toLowerCase() !== operation.expectedSha256?.toLowerCase()) {
        throw new BatchOperationError(
          "STALE_REVISION",
          "Batch write refused for " + operation.path +
            ": file changed since review (actual_sha256=" + originalSha256 + ").",
          operation.path
        );
      }
      if (!existed && operation.expectedSha256) {
        throw new BatchOperationError(
          "TARGET_NOT_FOUND",
          "Batch write refused for " + operation.path +
            ": expected_sha256 was supplied but the target does not exist.",
          operation.path
        );
      }
      updatedText = operation.content;
    } else {
      if (!existed || originalText === undefined || originalSha256 === undefined || !originalBuffer) {
        throw new BatchOperationError(
          "TARGET_NOT_FOUND",
          "Batch patch refused for " + operation.path + ": target file was not found.",
          operation.path
        );
      }
      if (!/^[a-f0-9]{64}$/i.test(operation.expectedSha256)) {
        throw new BatchOperationError(
          "INVALID_REQUEST",
          "expected_sha256 for " + operation.path + " must be a 64-character hexadecimal SHA-256.",
          operation.path
        );
      }
      if (originalSha256.toLowerCase() !== operation.expectedSha256.toLowerCase()) {
        throw new BatchOperationError(
          "STALE_REVISION",
          "Batch patch refused for " + operation.path +
            ": file changed since review (actual_sha256=" + originalSha256 + ").",
          operation.path
        );
      }

      try {
        updatedText = applyEditsToText(originalText, operation.edits);
      } catch (error) {
        if (error instanceof PatchEditError) {
          throw new BatchOperationError(
            error.code,
            "Batch patch refused for " + operation.path + ": " + error.message,
            operation.path
          );
        }
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch patch refused for " + operation.path + ": Could not apply edits.",
          operation.path
        );
      }
    }

    const updatedBuffer = Buffer.from(updatedText, "utf8");
    if (updatedBuffer.byteLength > writeLimit) {
      throw new BatchOperationError(
        "TOO_LARGE",
        "Batch target " + operation.path +
          " exceeds maxWriteBytes (" + writeLimit + ").",
        operation.path
      );
    }
    totalUpdatedBytes += updatedBuffer.byteLength;
    if (totalUpdatedBytes > MAX_BATCH_WRITE_BYTES) {
      throw new BatchOperationError(
        "TOO_LARGE",
        "Batch output exceeds the 1 MiB total write limit."
      );
    }
    if (originalBuffer) {
      totalSnapshotBytes += originalBuffer.byteLength;
      if (totalSnapshotBytes > MAX_BATCH_SNAPSHOT_BYTES) {
        throw new BatchOperationError(
          "TOO_LARGE",
          "Batch rollback snapshot exceeds the 8 MiB safety limit."
        );
      }
    }

    const diff = operation.kind === "patch" && operation.includeDiff && originalText !== undefined
      ? summarizeEdits(originalText, updatedText, operation.edits)
      : undefined;

    prepared.push({
      path: operation.path,
      safePath,
      canonicalKey,
      existed,
      ...(originalBuffer ? { originalBuffer } : {}),
      ...(originalSha256 ? { originalSha256 } : {}),
      updatedBuffer,
      sha256: sha256Buffer(updatedBuffer),
      ...(diff ? { diff } : {})
    });
  }

  return prepared;
}

async function commitBatchOperationsDetailed(
  prepared: PreparedBatchOperation[],
  hooks?: BatchCommitHooks
): Promise<BatchCommitOutcome> {
  type Opened = {
    operation: PreparedBatchOperation;
    handle: Awaited<ReturnType<typeof fs.open>>;
  };
  const opened: Opened[] = [];
  const attempted: PreparedBatchOperation[] = [];
  let currentOperation: PreparedBatchOperation | undefined;

  try {
    // Open all targets before changing any existing file. New files use "wx+" so a
    // concurrently-created target is never silently overwritten and can be read back
    // through the same handle.
    for (const operation of prepared) {
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(operation.safePath, operation.existed ? "r+" : "wx+");
      } catch (error) {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": " +
            safeBatchError(error, "Could not open target file."),
          operation.path
        );
      }
      opened.push({ operation, handle });

      if (operation.existed) {
        const current = await readHandleAtStart(handle);
        if (sha256Buffer(current) !== operation.originalSha256) {
          throw new BatchOperationError(
            "STALE_REVISION",
            "Batch operation refused for " + operation.path +
              ": file changed after preflight; no batch changes were applied.",
            operation.path
          );
        }
        decodeUtf8(current, "Batch target " + operation.path);
      }
    }

    for (let index = 0; index < opened.length; index += 1) {
      const entry = opened[index]!;
      const operation = entry.operation;
      currentOperation = operation;

      if (operation.existed) {
        // Recheck the same open file immediately before writing.
        const current = await readHandleAtStart(entry.handle);
        if (sha256Buffer(current) !== operation.originalSha256) {
          throw new BatchOperationError(
            "STALE_REVISION",
            "Batch operation refused for " + operation.path +
              ": file changed before commit; no batch changes were applied.",
            operation.path
          );
        }
      }

      // Include the current target before the first mutation so partial writes can be
      // rolled back if truncate/write/sync fails. Write first, then truncate any old
      // tail: a zero-progress write does not destroy the previous file contents.
      attempted.push(operation);
      await writeAllAtStart(entry.handle, operation.updatedBuffer);
      await entry.handle.truncate(operation.updatedBuffer.byteLength);
      await entry.handle.sync();

      const observed = await readBoundedSnapshot(
        entry.handle,
        operation.updatedBuffer.byteLength
      );
      if (!observed.bytes.equals(operation.updatedBuffer)) {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": write verification failed.",
          operation.path
        );
      }
      const pathStat = await fs.stat(operation.safePath, { bigint: true });
      if (pathStat.dev !== observed.stat.dev || pathStat.ino !== observed.stat.ino) {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": path identity changed during write.",
          operation.path
        );
      }
      await hooks?.afterWrite?.(operation.path, index);
    }

    // Recheck every observable target before declaring the batch committed.
    for (const entry of opened) {
      const operation = entry.operation;
      const observed = await readBoundedSnapshot(
        entry.handle,
        operation.updatedBuffer.byteLength
      );
      if (!observed.bytes.equals(operation.updatedBuffer)) {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": final write verification failed.",
          operation.path
        );
      }
      const pathStat = await fs.stat(operation.safePath, { bigint: true });
      if (pathStat.dev !== observed.stat.dev || pathStat.ino !== observed.stat.ino) {
        throw new BatchOperationError(
          "WRITE_FAILED",
          "Batch target " + operation.path + ": final path identity changed.",
          operation.path
        );
      }
    }

    return {
      ok: true,
      results: prepared.map((operation) => ({
        path: operation.path,
        bytes: operation.updatedBuffer.byteLength,
        sha256: operation.sha256,
        created: !operation.existed
      }))
    };
  } catch (error) {
    const rolledBack: string[] = [];
    const unknown: string[] = [];
    const attemptedExisting = attempted.filter((operation) => operation.existed);

    // Restore existing files only while they still contain the exact bytes this
    // batch wrote. Anything else may be an external edit or an incomplete write,
    // so preserve the scene and report an unknown effect instead of overwriting it.
    for (let index = attemptedExisting.length - 1; index >= 0; index -= 1) {
      const operation = attemptedExisting[index]!;
      const entry = opened.find((candidate) => candidate.operation === operation);
      if (!entry) {
        unknown.push(operation.path);
        continue;
      }

      try {
        await hooks?.beforeRollback?.(operation.path, prepared.indexOf(operation));
        const current = await readHandleAtStart(entry.handle);
        const currentSha = sha256Buffer(current);

        if (currentSha === operation.originalSha256) {
          rolledBack.push(operation.path);
          continue;
        }
        if (currentSha !== operation.sha256) {
          unknown.push(operation.path);
          continue;
        }

        await entry.handle.truncate(0);
        await writeAllAtStart(
          entry.handle,
          operation.originalBuffer ?? Buffer.alloc(0)
        );
        await entry.handle.sync();

        const restored = await readHandleAtStart(entry.handle);
        if (sha256Buffer(restored) !== operation.originalSha256) {
          unknown.push(operation.path);
          continue;
        }
        rolledBack.push(operation.path);
      } catch {
        unknown.push(operation.path);
      }
    }

    for (const entry of opened) {
      try {
        await entry.handle.close();
      } catch {
        // The original failure remains authoritative; cleanup below is still attempted.
      }
    }

    // Newly created targets are removed only when they still contain either the
    // bytes this batch wrote or the empty file created by "wx".
    const emptySha = sha256Buffer(Buffer.alloc(0));
    for (const entry of opened) {
      const operation = entry.operation;
      if (operation.existed) continue;
      const wasAttempted = attempted.includes(operation);
      try {
        if (wasAttempted) {
          await hooks?.beforeRollback?.(operation.path, prepared.indexOf(operation));
        }

        let current: Buffer;
        try {
          const readHandle = await fs.open(operation.safePath, "r");
          try {
            current = (await readBoundedSnapshot(readHandle, batchSnapshotLimit())).bytes;
          } finally {
            await readHandle.close().catch(() => undefined);
          }
        } catch (readError) {
          if ((readError as { code?: string })?.code === "ENOENT") {
            rolledBack.push(operation.path);
            continue;
          }
          throw readError;
        }

        const currentSha = sha256Buffer(current);
        if (currentSha === emptySha || currentSha === operation.sha256) {
          await fs.rm(operation.safePath, { force: true });
          rolledBack.push(operation.path);
        } else {
          unknown.push(operation.path);
        }
      } catch {
        unknown.push(operation.path);
      }
    }

    const effect: "none" | "rolled_back" | "unknown" =
      unknown.length > 0 ? "unknown" : attempted.length > 0 ? "rolled_back" : "none";
    const cause = safeBatchError(error, "Unexpected batch write failure.");
    const causeCode = error instanceof BatchOperationError ? error.code : "WRITE_FAILED";
    const causePath = error instanceof BatchOperationError
      ? error.targetPath
      : currentOperation?.path;
    const uniqueUnknown = [...new Set(unknown)];
    const uniqueRolledBack = [...new Set(rolledBack)];
    const message = effect === "unknown"
      ? "Batch operation failed and rollback was incomplete for: " +
        uniqueUnknown.join(", ") +
        ". Inspect these files immediately. Cause: " +
        cause
      : effect === "rolled_back"
        ? "Batch operation failed; attempted changes were rolled back. Cause: " + cause
        : "Batch operation failed before any change was applied. Cause: " + cause;

    return {
      ok: false,
      failure: {
        message,
        effect,
        cause,
        causeCode,
        ...(causePath ? { causePath } : {}),
        rolledBack: uniqueRolledBack,
        unknown: uniqueUnknown
      }
    };
  } finally {
    for (const entry of opened) {
      try {
        await entry.handle.close();
      } catch {
        // Already closed during rollback or closed successfully above.
      }
    }
  }
}

async function commitBatchOrThrow(
  prepared: PreparedBatchOperation[]
): Promise<BatchTextChangeResult[]> {
  const outcome = await withWriteLocks(
    prepared.map((operation) => operation.canonicalKey),
    () => commitBatchOperationsDetailed(prepared)
  );
  if (outcome.ok) return outcome.results;
  throw new Error(outcome.failure.message);
}

function patchOutcomeForCode(code: string): Outcome {
  return outcomeFor(code);
}

function patchFailureFile(pathValue: string, code: string, message: string): PatchFileResult {
  return {
    path: pathValue,
    ok: false,
    bytes: 0,
    created: false,
    applied: false,
    errorCode: code,
    error: message
  };
}

function patchPreflightFailureResult(error: unknown, dryRun: boolean): PatchBatchResult {
  const known = error instanceof BatchOperationError ? error : undefined;
  const patchError = error instanceof PatchEditError ? error : undefined;
  const code = known?.code ?? patchError?.code ?? "WRITE_FAILED";
  const message = known?.message ?? patchError?.message ?? "Could not prepare the patch batch.";
  const outcome = patchOutcomeForCode(code);
  const files = known?.targetPath
    ? [patchFailureFile(known.targetPath, code, message)]
    : [];

  return {
    contract_version: FILE_CONTRACT_VERSION,
    status: outcome.status === "error" ? "error" : "rejected",
    outcome,
    dry_run: dryRun,
    files,
    totalBytes: 0,
    successCount: 0,
    failureCount: files.length,
    error: message
  };
}

function patchDryRunResult(prepared: PreparedBatchOperation[]): PatchBatchResult {
  const files: PatchFileResult[] = prepared.map((operation) => ({
    path: operation.path,
    ok: true,
    bytes: operation.updatedBuffer.byteLength,
    sha256: operation.sha256,
    ...(operation.originalSha256 ? { original_sha256: operation.originalSha256 } : {}),
    created: false,
    applied: false,
    ...(operation.diff ? { diff: operation.diff } : {})
  }));
  return {
    contract_version: FILE_CONTRACT_VERSION,
    status: "dry_run",
    outcome: {
      status: "completed",
      effectState: "none",
      retry: "safe",
      code: "DRY_RUN",
      nextAction: "Review the expected hash and diff, then submit with dry_run=false."
    },
    dry_run: true,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    successCount: files.length,
    failureCount: 0
  };
}

function patchCommitSuccessResult(
  results: BatchTextChangeResult[],
  prepared: PreparedBatchOperation[]
): PatchBatchResult {
  const files: PatchFileResult[] = results.map((result, index) => {
    const operation = prepared[index];
    return {
      path: result.path,
      ok: true,
      bytes: result.bytes,
      sha256: result.sha256,
      ...(operation?.originalSha256 ? { original_sha256: operation.originalSha256 } : {}),
      created: result.created,
      applied: true
    };
  });
  return {
    contract_version: FILE_CONTRACT_VERSION,
    status: "committed",
    outcome: {
      status: "completed",
      effectState: "applied",
      retry: "safe",
      code: "PATCH_APPLIED",
      nextAction: "Use each returned sha256 as the expected_sha256 for the next edit."
    },
    dry_run: false,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    successCount: files.length,
    failureCount: 0
  };
}

function patchCommitFailureResult(
  failure: BatchCommitFailure,
  prepared: PreparedBatchOperation[]
): PatchBatchResult {
  const unknown = new Set(failure.unknown);
  const rolledBack = new Set(failure.rolledBack);
  const files: PatchFileResult[] = prepared.map((operation) => {
    if (unknown.has(operation.path)) {
      return patchFailureFile(
        operation.path,
        "ROLLBACK_UNCONFIRMED",
        "Rollback could not be confirmed; inspect this file before retrying."
      );
    }
    if (rolledBack.has(operation.path)) {
      return patchFailureFile(
        operation.path,
        "ROLLED_BACK",
        "Batch write failed; this file was restored to its original content."
      );
    }
    if (operation.path === failure.causePath) {
      return patchFailureFile(operation.path, failure.causeCode, failure.cause);
    }
    return patchFailureFile(
      operation.path,
      "BATCH_ABORTED",
      "Batch aborted before this file was changed."
    );
  });

  let status: PatchBatchStatus;
  let outcome: Outcome;
  if (failure.effect === "unknown") {
    status = "unknown";
    outcome = {
      status: "unknown",
      effectState: "unknown",
      retry: "never_automatic",
      code: "ROLLBACK_UNCONFIRMED",
      nextAction: "Inspect the listed files before retrying; do not assume either version is current."
    };
  } else if (failure.effect === "rolled_back") {
    status = "rolled_back";
    outcome = {
      status: "error",
      effectState: "rolled_back",
      retry: "safe",
      code: "ROLLED_BACK",
      nextAction: "The files were restored; re-read their versions before retrying."
    };
  } else {
    outcome = patchOutcomeForCode(failure.causeCode);
    status = outcome.status === "conflict" || outcome.status === "rejected"
      ? "rejected"
      : "error";
  }

  return {
    contract_version: FILE_CONTRACT_VERSION,
    status,
    outcome,
    dry_run: false,
    files,
    totalBytes: 0,
    successCount: 0,
    failureCount: files.length,
    error: failure.cause
  };
}

export async function writeTextFilesBatch(
  entries: BatchWriteInput[],
  baseDir = config.defaultCwd
): Promise<BatchTextChangeResult[]> {
  const prepared = await prepareBatchOperations(
    entries.map((entry) => ({
      kind: "write" as const,
      path: entry.path,
      content: entry.content,
      ...(entry.expectedSha256 ? { expectedSha256: entry.expectedSha256 } : {})
    })),
    baseDir
  );
  return commitBatchOrThrow(prepared);
}

export async function patchTextFilesBatch(
  entries: BatchPatchInput[],
  baseDir = config.defaultCwd
): Promise<BatchTextChangeResult[]> {
  const prepared = await prepareBatchOperations(
    entries.map((entry) => ({
      kind: "patch" as const,
      path: entry.path,
      expectedSha256: entry.expectedSha256,
      edits: [{ old_text: entry.oldText, new_text: entry.newText }]
    })),
    baseDir
  );
  return commitBatchOrThrow(prepared);
}

/**
 * V2 multi-edit patch batch. Every file is located against its one reviewed
 * revision. The whole batch is preflighted before any mutation; dry_run returns
 * expected hashes and a bounded diff without writing.
 */
export async function patchTextFilesBatchV2(
  entries: BatchMultiPatchInput[],
  baseDir = config.defaultCwd,
  options: PatchBatchV2Options = {}
): Promise<PatchBatchResult> {
  const dryRun = options.dryRun === true;

  if (entries.length < 1 || entries.length > MAX_BATCH_FILE_COUNT) {
    return patchPreflightFailureResult(
      new BatchOperationError(
        "INVALID_REQUEST",
        "Batch operation requires 1 to " + MAX_BATCH_FILE_COUNT + " files."
      ),
      dryRun
    );
  }

  let prepared: PreparedBatchOperation[];
  try {
    prepared = await prepareBatchOperations(
      entries.map((entry) => ({
        kind: "patch" as const,
        path: entry.path,
        expectedSha256: entry.expectedSha256,
        edits: entry.edits,
        includeDiff: dryRun
      })),
      baseDir
    );
  } catch (error) {
    return patchPreflightFailureResult(error, dryRun);
  }

  if (dryRun) return patchDryRunResult(prepared);

  let outcome: BatchCommitOutcome;
  try {
    outcome = await withWriteLocks(
      prepared.map((operation) => operation.canonicalKey),
      () => commitBatchOperationsDetailed(prepared, options.hooks)
    );
  } catch (error) {
    return patchPreflightFailureResult(error, false);
  }

  return outcome.ok
    ? patchCommitSuccessResult(outcome.results, prepared)
    : patchCommitFailureResult(outcome.failure, prepared);
}

export type TextSearchMatch = {
  line: number;
  occurrences: number;
  snippet: string;
};

export type TextSearchFileResult = {
  path: string;
  matchCount: number;
  matches: TextSearchMatch[];
  matchesTruncated: boolean;
};

export type TextSearchResult = {
  query: string;
  root: string;
  scannedFiles: number;
  skippedFiles: number;
  totalBytesScanned: number;
  matchCount: number;
  matchedFiles: number;
  truncated: boolean;
  results: TextSearchFileResult[];
};

export type TextSearchV2Result = TextSearchResult & {
  contract_version: 2;
  coverage: SearchCoverage;
  outcome: Outcome;
};

/** Test-only read injection; MCP handlers never pass this. */
export type SearchTestHooks = {
  beforeRead?: (filePath: string) => Promise<void> | void;
};

export type TextSearchOptions = {
  caseSensitive?: boolean;
  maxResults?: number;
  testHooks?: SearchTestHooks;
};

const SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git", ".p05", ".ssh", ".aws", "node_modules", "dist", ".vscode"
]);
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_ENTRIES = 10000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_MATCHES_PER_FILE = 5;

async function runSearch(
  query: string,
  rootPath: string,
  baseDir: string,
  options: TextSearchOptions
): Promise<{ textResult: TextSearchResult; coverage: SearchCoverage; hadIoError: boolean }> {
  if (!query.trim()) throw new Error("Search query must not be empty.");
  if (Buffer.byteLength(query, "utf8") > 500) {
    throw new Error("Search query exceeds the 500-byte limit.");
  }

  const maxResults = Math.max(1, Math.min(Math.trunc(options.maxResults ?? 50), 100));
  const safeRoot = await assertAccessiblePath(rootPath, "read", baseDir, baseDir);
  const rootInfo = await fs.lstat(safeRoot);
  if (rootInfo.isSymbolicLink()) {
    throw new Error("Search root cannot be a symbolic link.");
  }
  if (!rootInfo.isDirectory()) {
    throw new Error("Search root must be a directory.");
  }

  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const queue = [safeRoot];
  const results: TextSearchFileResult[] = [];
  const skippedByReason: Record<string, number> = {};
  let scannedFiles = 0;
  let skippedFiles = 0;
  let totalBytesScanned = 0;
  let totalMatchCount = 0;
  let visitedEntries = 0;
  let limitStop: SearchStopReason | undefined;
  let hadIoError = false;

  const skip = (reason: string): void => {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    skippedFiles += 1;
  };

  while (queue.length > 0 && limitStop === undefined) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skip("directory_read_error");
      hadIoError = true;
      continue;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_SEARCH_ENTRIES) {
        limitStop = "file_limit";
        break;
      }

      const name = entry.name.replace(/[. ]+$/, "").toLowerCase();
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skip("symlink");
        continue;
      }
      if (entry.isDirectory()) {
        if (!SEARCH_IGNORED_DIRECTORIES.has(name)) queue.push(fullPath);
        else skip("generated_directory");
        continue;
      }
      if (!entry.isFile()) {
        skip("non_file");
        continue;
      }
      if (scannedFiles >= MAX_SEARCH_FILES) {
        limitStop = "file_limit";
        break;
      }
      if (protectionReason(fullPath)) {
        skip("protected");
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        skip("stat_error");
        hadIoError = true;
        continue;
      }
      if (stat.size > config.maxReadBytes) {
        skip("oversized");
        continue;
      }
      if (totalBytesScanned + stat.size > MAX_SEARCH_BYTES) {
        limitStop = "byte_limit";
        break;
      }

      const relativePath = path.relative(baseDir, fullPath) || ".";
      let text: string;
      try {
        await options.testHooks?.beforeRead?.(fullPath);
        text = await readTextFile(relativePath, baseDir);
      } catch {
        skip("read_error");
        hadIoError = true;
        continue;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (totalBytesScanned + bytes > MAX_SEARCH_BYTES) {
        limitStop = "byte_limit";
        break;
      }
      scannedFiles += 1;
      totalBytesScanned += bytes;
      if (text.includes("\0")) {
        skip("binary");
        continue;
      }

      const lines = text.split(/\r?\n/);
      const fileResult: TextSearchFileResult = {
        path: relativePath,
        matchCount: 0,
        matches: [],
        matchesTruncated: false
      };
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
        let offset = 0;
        let occurrences = 0;
        while (offset <= haystack.length - needle.length) {
          const found = haystack.indexOf(needle, offset);
          if (found < 0) break;
          occurrences += 1;
          offset = found + Math.max(needle.length, 1);
        }
        if (occurrences === 0) continue;

        fileResult.matchCount += occurrences;
        if (fileResult.matches.length < MAX_SEARCH_MATCHES_PER_FILE) {
          fileResult.matches.push({
            line: index + 1,
            occurrences,
            snippet: line.length > 240 ? line.slice(0, 237) + "..." : line
          });
        } else {
          fileResult.matchesTruncated = true;
        }
      }

      if (fileResult.matchCount > 0) {
        results.push(fileResult);
        totalMatchCount += fileResult.matchCount;
        if (results.length >= maxResults) {
          limitStop = "result_limit";
          break;
        }
      }
    }
  }

  const stopReason: SearchStopReason = limitStop ?? (hadIoError ? "io_error" : "exhausted");
  const coverage: SearchCoverage = {
    complete: stopReason === "exhausted",
    stopReason,
    scannedFiles,
    skippedByReason
  };
  const textResult: TextSearchResult = {
    query,
    root: rootPath,
    scannedFiles,
    skippedFiles,
    totalBytesScanned,
    matchCount: totalMatchCount,
    matchedFiles: results.length,
    truncated: limitStop !== undefined,
    results
  };

  return { textResult, coverage, hadIoError };
}

export async function searchTextFiles(
  query: string,
  rootPath = ".",
  baseDir = config.defaultCwd,
  options: TextSearchOptions = {}
): Promise<TextSearchResult> {
  return (await runSearch(query, rootPath, baseDir, options)).textResult;
}

/**
 * V2 search keeps the legacy result fields and adds explicit coverage. A normal
 * limit stop is partial/safe; any io_error is an actual failure even when some
 * results were collected.
 */
export async function searchTextFilesV2(
  query: string,
  rootPath = ".",
  baseDir = config.defaultCwd,
  options: TextSearchOptions = {}
): Promise<TextSearchV2Result> {
  const { textResult, coverage, hadIoError } = await runSearch(
    query,
    rootPath,
    baseDir,
    options
  );
  const outcome = hadIoError
    ? outcomeFor("SEARCH_IO_ERROR")
    : coverage.complete
      ? outcomeFor("SEARCH_COMPLETE")
      : outcomeFor("SEARCH_TRUNCATED");

  return {
    ...textResult,
    contract_version: FILE_CONTRACT_VERSION,
    coverage,
    outcome
  };
}
