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

/**
 * Paths that stay off-limits even when they sit inside an allowed root.
 *
 * Two distinct concerns, deliberately in one list:
 *  - secrets/credentials: reading them through a remote client is exfiltration;
 *  - code-execution vectors: writing `.git/hooks/*`, `.git/config` or `.npmrc`
 *    turns a plain file write into arbitrary code execution on the next git/npm
 *    operation, which would defeat the entire tool-profile gate.
 */
const protectedPathSegments = new Set([".git", ".p05", ".ssh", ".aws"]);

const protectedBasenames = new Set([
  ".env",
  ".env.local",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials"
]);

/** Templates that only document variable names, never real values. */
const allowedEnvTemplates = new Set([".env.example", ".env.sample", ".env.template"]);

const protectedExtensions = new Set([".pem", ".pfx", ".p12"]);

function protectionReason(resolvedPath: string): string | undefined {
  const segments = resolvedPath.split(path.sep).filter(Boolean);
  const protectedSegment = segments.find((segment) => protectedPathSegments.has(segment.toLowerCase()));
  if (protectedSegment) return `path segment "${protectedSegment}" is protected`;

  const base = path.basename(resolvedPath).toLowerCase();
  if (allowedEnvTemplates.has(base)) return undefined;
  if (protectedBasenames.has(base) || base.startsWith(".env.")) return `"${base}" may hold secrets`;
  if (protectedExtensions.has(path.extname(base))) return `"${path.extname(base)}" may hold private keys`;

  return undefined;
}

/**
 * Guard for the filesystem tools: allowed root first, then the protected-path list.
 * Read and write share one list today; if write-side approval is added later, the
 * divergence belongs here.
 */
export function assertAccessiblePath(input: string, access: "read" | "write"): string {
  const resolved = assertAllowedPath(input);
  const reason = protectionReason(resolved);
  if (reason) {
    throw new Error(`Path refused for ${access}: ${resolved} (${reason}).`);
  }
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
