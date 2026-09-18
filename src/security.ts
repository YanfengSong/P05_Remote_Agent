import path from "node:path";
import { config } from "./config.js";

function normalizeForCompare(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertAllowedPath(input: string): string {
  const resolved = path.resolve(input);
  const candidate = normalizeForCompare(resolved);
  const allowed = config.allowedRoots.some((root) => {
    const normalizedRoot = normalizeForCompare(root);
    return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
  });
  if (!allowed) throw new Error(`Path is outside allowed roots: ${resolved}`);
  return resolved;
}

const blockedCommandPatterns = [
  /\bformat\b/i, /\bdiskpart\b/i, /\bshutdown\b/i, /\breboot\b/i,
  /\bbcdedit\b/i, /\breg(\.exe)?\b/i, /\bnetsh\b/i, /\brunas\b/i,
  /\btakeown\b/i, /\bcipher\b/i,
  /\bRemove-Item\b.*\b-Recurse\b.*\b-Force\b/i,
  /\brm\b.*\s-rf\b/i
];

export function assertSafeCommand(command: string): void {
  const hit = blockedCommandPatterns.find((pattern) => pattern.test(command));
  if (hit) throw new Error(`Command blocked by safety policy: ${hit}`);
}
