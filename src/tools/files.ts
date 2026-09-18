import fs from "node:fs/promises";
import path from "node:path";
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

export async function readTextFile(filePath: string): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "read");
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

export async function writeTextFile(filePath: string, content: string): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "write");
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
  return safePath;
}

export async function listDirectory(dirPath: string): Promise<string[]> {
  const safePath = await assertAccessiblePath(dirPath, "read");
  try {
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    return entries.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
  } catch (error) {
    throw describeError(error, "Could not list the directory.");
  }
}
