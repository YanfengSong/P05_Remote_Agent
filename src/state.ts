import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function defaultP05StateDir(): string {
  return path.join(repoRoot, ".p05");
}

export function assertP05RepoPath(raw: string, label = "P05 path"): string {
  const resolved = path.resolve(raw);
  const root = normalizeForCompare(repoRoot);
  const candidate = normalizeForCompare(resolved);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(
      `${label} must remain inside the P05 repository (${repoRoot}); got ${resolved}.`
    );
  }
  return resolved;
}

export function p05StateDir(raw = process.env.P05_STATE_DIR): string {
  return assertP05RepoPath(
    raw?.trim() || defaultP05StateDir(),
    "P05_STATE_DIR"
  );
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
