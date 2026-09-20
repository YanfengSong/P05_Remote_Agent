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