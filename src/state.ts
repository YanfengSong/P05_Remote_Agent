import fs from "node:fs";
import path from "node:path";

export function p05StateDir(): string {
  return path.resolve(process.env.P05_STATE_DIR ?? path.join(process.cwd(), ".p05"));
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
