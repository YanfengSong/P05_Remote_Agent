import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { assertAccessiblePath } from "../security.js";

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

export async function readTextFile(filePath: string, baseDir = config.defaultCwd): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "read", baseDir, baseDir);
  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch (error) {
    throw describeError(error, "Could not read the file.");
  }
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > config.maxReadBytes) {
    throw new Error(`File exceeds maxReadBytes (${config.maxReadBytes}).`);
  }
  try {
    return await fs.readFile(safePath, "utf8");
  } catch (error) {
    throw describeError(error, "Could not read the file.");
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
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > config.maxWriteBytes) {
    throw new Error(`Content exceeds maxWriteBytes (${config.maxWriteBytes}).`);
  }
  try {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, "utf8");
  } catch (error) {
    throw describeError(error, "Could not write the file.");
  }
  return { bytes };
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
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("expected_sha256 must be a 64-character hexadecimal SHA-256.");
  }
  if (oldText.length === 0) throw new Error("old_text must not be empty.");

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
  if (current.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error("Patch refused: old_text is ambiguous because it occurs more than once.");
  }

  const updated = current.slice(0, first) + newText + current.slice(first + oldText.length);
  const bytes = Buffer.byteLength(updated, "utf8");
  if (bytes > config.maxWriteBytes) {
    throw new Error(`Patched content exceeds maxWriteBytes (${config.maxWriteBytes}).`);
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

type BatchOperation =
  | { kind: "write"; path: string; content: string; expectedSha256?: string }
  | { kind: "patch"; path: string; expectedSha256: string; oldText: string; newText: string };

type PreparedBatchOperation = {
  path: string;
  safePath: string;
  canonicalKey: string;
  existed: boolean;
  originalBuffer?: Buffer;
  originalSha256?: string;
  updatedBuffer: Buffer;
  sha256: string;
};

const MAX_BATCH_FILE_COUNT = 20;
const MAX_BATCH_WRITE_BYTES = 1024 * 1024;
const MAX_BATCH_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeBatchError(error: unknown, fallback: string): string {
  if ((error as { code?: string })?.code) {
    return describeError(error, fallback).message;
  }
  return error instanceof Error ? error.message : fallback;
}

function decodeUtf8(buffer: Buffer, label: string): string {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new Error(label + " is not valid UTF-8 text.");
  }
  return text;
}

async function readHandleAtStart(
  handle: Awaited<ReturnType<typeof fs.open>>
): Promise<Buffer> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new Error("Batch target is not a regular file.");
  if (stat.size > config.maxReadBytes) {
    throw new Error("Batch target exceeds maxReadBytes (" + config.maxReadBytes + ").");
  }

  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function prepareBatchOperations(
  operations: BatchOperation[],
  baseDir: string
): Promise<PreparedBatchOperation[]> {
  if (operations.length < 1 || operations.length > MAX_BATCH_FILE_COUNT) {
    throw new Error("Batch operation requires 1 to " + MAX_BATCH_FILE_COUNT + " files.");
  }

  const seen = new Set<string>();
  const prepared: PreparedBatchOperation[] = [];
  let totalUpdatedBytes = 0;
  let totalSnapshotBytes = 0;

  for (const operation of operations) {
    const safePath = await assertAccessiblePath(operation.path, "write", baseDir, baseDir);
    const parentPath = path.dirname(safePath);
    let parentStat;
    try {
      parentStat = await fs.stat(parentPath);
    } catch (error) {
      throw new Error("Batch target " + operation.path + ": " +
        safeBatchError(error, "Parent directory is unavailable."));
    }
    if (!parentStat.isDirectory()) {
      throw new Error("Batch target " + operation.path + ": parent path is not a directory.");
    }

    let realParent: string;
    try {
      realParent = await fs.realpath(parentPath);
    } catch (error) {
      throw new Error("Batch target " + operation.path + ": " +
        safeBatchError(error, "Parent directory is unavailable."));
    }
    const canonicalPath = path.join(realParent, path.basename(safePath));
    const canonicalKey = process.platform === "win32"
      ? canonicalPath.toLowerCase()
      : canonicalPath;
    if (seen.has(canonicalKey)) {
      throw new Error("Batch operation contains duplicate target paths: " + operation.path);
    }
    seen.add(canonicalKey);

    let existed = true;
    let originalBuffer: Buffer | undefined;
    let originalText: string | undefined;
    let originalSha256: string | undefined;
    try {
      const stat = await fs.lstat(safePath);
      if (stat.isSymbolicLink()) {
        throw new Error("Batch target " + operation.path + " is a symbolic link; refusing mutation.");
      }
      if (!stat.isFile()) {
        throw new Error("Batch target " + operation.path + " is not a regular file.");
      }
      if (stat.nlink > 1) {
        throw new Error("Batch target " + operation.path + " has multiple hard links; refusing mutation.");
      }
      if (stat.size > config.maxReadBytes) {
        throw new Error("Batch target " + operation.path + " exceeds maxReadBytes (" + config.maxReadBytes + ").");
      }
      originalBuffer = await fs.readFile(safePath);
      originalText = decodeUtf8(originalBuffer, "Batch target " + operation.path);
      originalSha256 = sha256Buffer(originalBuffer);
    } catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") {
        existed = false;
      } else {
        throw new Error("Batch target " + operation.path + ": " +
          safeBatchError(error, "Could not inspect the target file."));
      }
    }

    let updatedText: string;
    if (operation.kind === "write") {
      if (operation.expectedSha256 && !/^[a-f0-9]{64}$/i.test(operation.expectedSha256)) {
        throw new Error("expected_sha256 for " + operation.path + " must be a 64-character hexadecimal SHA-256.");
      }
      if (existed && !operation.expectedSha256) {
        throw new Error("Batch write refused for existing file " + operation.path +
          ": expected_sha256 is required. Re-read the file before replacing it.");
      }
      if (existed && originalSha256?.toLowerCase() !== operation.expectedSha256?.toLowerCase()) {
        throw new Error("Batch write refused for " + operation.path +
          ": file changed since review (actual_sha256=" + originalSha256 + ").");
      }
      if (!existed && operation.expectedSha256) {
        throw new Error("Batch write refused for " + operation.path +
          ": expected_sha256 was supplied but the target does not exist.");
      }
      updatedText = operation.content;
    } else {
      if (!existed || originalText === undefined || originalSha256 === undefined || !originalBuffer) {
        throw new Error("Batch patch refused for " + operation.path + ": target file was not found.");
      }
      if (!/^[a-f0-9]{64}$/i.test(operation.expectedSha256)) {
        throw new Error("expected_sha256 for " + operation.path + " must be a 64-character hexadecimal SHA-256.");
      }
      if (originalSha256.toLowerCase() !== operation.expectedSha256.toLowerCase()) {
        throw new Error("Batch patch refused for " + operation.path +
          ": file changed since review (actual_sha256=" + originalSha256 + ").");
      }
      if (operation.oldText.length === 0) {
        throw new Error("Batch patch refused for " + operation.path + ": old_text must not be empty.");
      }
      const first = originalText.indexOf(operation.oldText);
      if (first < 0) {
        throw new Error("Batch patch refused for " + operation.path + ": old_text was not found.");
      }
      if (originalText.indexOf(operation.oldText, first + operation.oldText.length) >= 0) {
        throw new Error("Batch patch refused for " + operation.path +
          ": old_text is ambiguous because it occurs more than once.");
      }
      updatedText = originalText.slice(0, first) + operation.newText +
        originalText.slice(first + operation.oldText.length);
    }

    const updatedBuffer = Buffer.from(updatedText, "utf8");
    if (updatedBuffer.byteLength > config.maxWriteBytes) {
      throw new Error("Batch target " + operation.path +
        " exceeds maxWriteBytes (" + config.maxWriteBytes + ").");
    }
    totalUpdatedBytes += updatedBuffer.byteLength;
    if (totalUpdatedBytes > MAX_BATCH_WRITE_BYTES) {
      throw new Error("Batch output exceeds the 1 MiB total write limit.");
    }
    if (originalBuffer) {
      totalSnapshotBytes += originalBuffer.byteLength;
      if (totalSnapshotBytes > MAX_BATCH_SNAPSHOT_BYTES) {
        throw new Error("Batch rollback snapshot exceeds the 8 MiB safety limit.");
      }
    }

    prepared.push({
      path: operation.path,
      safePath,
      canonicalKey,
      existed,
      ...(originalBuffer ? { originalBuffer } : {}),
      ...(originalSha256 ? { originalSha256 } : {}),
      updatedBuffer,
      sha256: sha256Buffer(updatedBuffer)
    });
  }

  return prepared;
}

async function commitBatchOperations(
  prepared: PreparedBatchOperation[]
): Promise<BatchTextChangeResult[]> {
  type Opened = {
    operation: PreparedBatchOperation;
    handle: Awaited<ReturnType<typeof fs.open>>;
  };
  const opened: Opened[] = [];
  const attempted: PreparedBatchOperation[] = [];

  try {
    // Open all targets before changing any existing file. New files use "wx" so a
    // concurrently-created target is never silently overwritten.
    for (const operation of prepared) {
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(operation.safePath, operation.existed ? "r+" : "wx");
      } catch (error) {
        throw new Error("Batch target " + operation.path + ": " +
          safeBatchError(error, "Could not open target file."));
      }
      opened.push({ operation, handle });

      if (operation.existed) {
        const current = await readHandleAtStart(handle);
        if (sha256Buffer(current) !== operation.originalSha256) {
          throw new Error("Batch operation refused for " + operation.path +
            ": file changed after preflight; no batch changes were applied.");
        }
        decodeUtf8(current, "Batch target " + operation.path);
      }
    }

    for (const entry of opened) {
      const operation = entry.operation;
      if (operation.existed) {
        // Recheck the same open file immediately before writing.
        const current = await readHandleAtStart(entry.handle);
        if (sha256Buffer(current) !== operation.originalSha256) {
          throw new Error("Batch operation refused for " + operation.path +
            ": file changed before commit; no batch changes were applied.");
        }
      }

      // Include the current target before the first mutation so partial writes can be
      // rolled back if truncate/write/sync fails.
      attempted.push(operation);
      if (operation.existed) await entry.handle.truncate(0);
      if (operation.updatedBuffer.byteLength > 0) {
        await entry.handle.write(
          operation.updatedBuffer,
          0,
          operation.updatedBuffer.byteLength,
          0
        );
      }
      await entry.handle.sync();
    }

    return prepared.map((operation) => ({
      path: operation.path,
      bytes: operation.updatedBuffer.byteLength,
      sha256: operation.sha256,
      created: !operation.existed
    }));
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const operation of [...attempted].reverse()) {
      if (!operation.existed || !operation.originalBuffer) continue;
      const entry = opened.find((candidate) => candidate.operation === operation);
      if (!entry) {
        rollbackFailures.push(operation.path);
        continue;
      }
      try {
        await entry.handle.truncate(0);
        if (operation.originalBuffer.byteLength > 0) {
          await entry.handle.write(
            operation.originalBuffer,
            0,
            operation.originalBuffer.byteLength,
            0
          );
        }
        await entry.handle.sync();
      } catch {
        rollbackFailures.push(operation.path);
      }
    }

    for (const entry of opened) {
      try {
        await entry.handle.close();
      } catch {
        // The original failure remains authoritative; cleanup below is still attempted.
      }
    }
    for (const entry of opened) {
      if (entry.operation.existed) continue;
      try {
        await fs.rm(entry.operation.safePath, { force: true });
      } catch {
        rollbackFailures.push(entry.operation.path);
      }
    }

    const detail = safeBatchError(error, "Unexpected batch write failure.");
    if (rollbackFailures.length > 0) {
      throw new Error("Batch operation failed and rollback was incomplete for: " +
        [...new Set(rollbackFailures)].join(", ") + ". Inspect these files immediately. Cause: " + detail);
    }
    throw new Error("Batch operation failed; attempted changes were rolled back. Cause: " + detail);
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
  return commitBatchOperations(prepared);
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
      oldText: entry.oldText,
      newText: entry.newText
    })),
    baseDir
  );
  return commitBatchOperations(prepared);
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

const SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git", ".p05", ".ssh", ".aws", "node_modules", "dist", ".vscode"
]);
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_ENTRIES = 10000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_MATCHES_PER_FILE = 5;

export async function searchTextFiles(
  query: string,
  rootPath = ".",
  baseDir = config.defaultCwd,
  options: { caseSensitive?: boolean; maxResults?: number } = {}
): Promise<TextSearchResult> {
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
  let scannedFiles = 0;
  let skippedFiles = 0;
  let totalBytesScanned = 0;
  let totalMatchCount = 0;
  let visitedEntries = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_SEARCH_ENTRIES) {
        truncated = true;
        break;
      }

      const name = entry.name.replace(/[. ]+$/, "").toLowerCase();
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SEARCH_IGNORED_DIRECTORIES.has(name)) queue.push(fullPath);
        else skippedFiles += 1;
        continue;
      }
      if (!entry.isFile()) {
        skippedFiles += 1;
        continue;
      }
      if (scannedFiles >= MAX_SEARCH_FILES) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (stat.size > config.maxReadBytes) {
        skippedFiles += 1;
        continue;
      }
      if (totalBytesScanned + stat.size > MAX_SEARCH_BYTES) {
        truncated = true;
        break;
      }

      const relativePath = path.relative(baseDir, fullPath) || ".";
      let text: string;
      try {
        text = await readTextFile(relativePath, baseDir);
      } catch {
        skippedFiles += 1;
        continue;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (totalBytesScanned + bytes > MAX_SEARCH_BYTES) {
        truncated = true;
        break;
      }
      scannedFiles += 1;
      totalBytesScanned += bytes;
      if (text.includes("\0")) {
        skippedFiles += 1;
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
          truncated = true;
          break;
        }
      }
    }
  }

  return {
    query,
    root: rootPath,
    scannedFiles,
    skippedFiles,
    totalBytesScanned,
    matchCount: totalMatchCount,
    matchedFiles: results.length,
    truncated,
    results
  };
}
