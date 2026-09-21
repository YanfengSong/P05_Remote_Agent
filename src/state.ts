import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");

export function defaultP05StateDir(): string {
  return path.join(repoRoot, ".p05");
}

export function p05StateDir(raw = process.env.P05_STATE_DIR): string {
  return path.resolve(raw?.trim() || defaultP05StateDir());
}

export function ensureP05StateDir(): string {
  const dir = p05StateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function p05StatePath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid P05 state filename.");
  return path.join(ensureP05StateDir(), name);
}
