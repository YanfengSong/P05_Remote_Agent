import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { assertAccessiblePath } from "../security.js";

export async function readTextFile(filePath: string): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "read");
  const stat = await fs.stat(safePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > config.maxReadBytes) {
    throw new Error(`File exceeds maxReadBytes (${config.maxReadBytes}).`);
  }
  return fs.readFile(safePath, "utf8");
}

export async function writeTextFile(filePath: string, content: string): Promise<string> {
  const safePath = await assertAccessiblePath(filePath, "write");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > config.maxWriteBytes) {
    throw new Error(`Content exceeds maxWriteBytes (${config.maxWriteBytes}).`);
  }
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, content, "utf8");
  return safePath;
}

export async function listDirectory(dirPath: string): Promise<string[]> {
  const safePath = await assertAccessiblePath(dirPath, "read");
  const entries = await fs.readdir(safePath, { withFileTypes: true });
  return entries.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
}
