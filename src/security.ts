import fs from "node:fs/promises";
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
 * Reject path spellings whose meaning a string comparison cannot reason about.
 *
 * These are not style preferences: each one changes which file the OS actually
 * touches while leaving the string looking harmless, which is exactly how a path
 * policy gets bypassed.
 */
function shapeProblem(input: string): string | undefined {
  if (process.platform !== "win32") return undefined;

  if (/^\\\\/.test(input) || /^\/\//.test(input)) {
    return "UNC and extended-length (\\\\?\\) paths are not supported by this policy";
  }
  if (/^[a-zA-Z]:(?![\\/])/.test(input)) {
    return "drive-relative paths (e.g. F:foo) are not supported";
  }
  const afterDrive = /^[a-zA-Z]:/.test(input) ? input.slice(2) : input;
  if (afterDrive.includes(":")) {
    return "alternate data streams (name:stream) are not supported";
  }
  return undefined;
}

/** Resolve a path after rejecting spellings the policy will not evaluate. */
export function assertPathShape(input: string, access: Access): string {
  const problem = shapeProblem(input);
  if (problem) throw new Error(`Path refused for ${access}: ${input} (${problem}).`);
  return path.resolve(input);
}

export type Access = "read" | "write";

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

/**
 * Windows strips trailing dots and spaces from a path component, so `.git.` and
 * `.git ` name the same directory as `.git`. Compare on the stripped form or the
 * protected-name match is trivially bypassed.
 */
function canonicalSegment(segment: string): string {
  return segment.replace(/[. ]+$/, "").toLowerCase();
}

export function protectionReason(resolvedPath: string): string | undefined {
  const segments = resolvedPath.split(path.sep).filter(Boolean).map(canonicalSegment);
  const protectedSegment = segments.find((segment) => protectedPathSegments.has(segment));
  if (protectedSegment) return `path segment "${protectedSegment}" is protected`;

  const base = canonicalSegment(path.basename(resolvedPath));
  if (allowedEnvTemplates.has(base)) return undefined;
  if (protectedBasenames.has(base) || base.startsWith(".env.")) return `"${base}" may hold secrets`;
  if (protectedExtensions.has(path.extname(base))) return `"${path.extname(base)}" may hold private keys`;

  return undefined;
}

/**
 * Real path of `target`, resolving symlinks, NTFS junctions and short (8.3) names.
 * If the leaf does not exist yet, the nearest existing ancestor is resolved and the
 * remaining segments are re-appended, so a write to a new file still gets a real
 * parent directory checked.
 */
async function resolveRealPath(target: string): Promise<string> {
  let current = target;
  const pending: string[] = [];

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return pending.length === 0 ? real : path.join(real, ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target; // nothing on this path exists
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Guard for the filesystem tools: path shape, allowed root, protected paths, and
 * the resolved real path.
 *
 * The real-path pass is what stops an escape through a symlink or junction that
 * already exists inside an allowed root: the string looks local, the target is not.
 * Residual risk: a hard link inside the tree (realpath cannot see those) and the
 * TOCTOU window between this check and the caller's open().
 */
export async function assertAccessiblePath(input: string, access: Access): Promise<string> {
  const resolved = assertAllowedPath(assertPathShape(input, access));

  const directReason = protectionReason(resolved);
  if (directReason) throw new Error(`Path refused for ${access}: ${resolved} (${directReason}).`);

  const real = await resolveRealPath(resolved);
  if (normalizeForCompare(real) !== normalizeForCompare(resolved)) {
    assertAllowedPath(real); // a link must still land inside the allowed roots
    const realReason = protectionReason(real); // ...and must not land on a protected path
    if (realReason) {
      throw new Error(`Path refused for ${access}: ${resolved} resolves to ${real} (${realReason}).`);
    }
  }

  return resolved;
}

const blockedCommandPatterns = [
  /\bformat\b/i, /\bdiskpart\b/i, /\bshutdown\b/i, /\breboot\b/i,
  /\bbcdedit\b/i, /\breg(\.exe)?\b/i, /\bnetsh\b/i, /\brunas\b/i,
  /\btakeown\b/i, /\bcipher\b/i,
  // No \b before "-Recurse": between a space and "-" there is no word boundary, so
  // the old /\b-Recurse\b/ form never matched and this rule was dead.
  /\bRemove-Item\b[\s\S]*-Recurse[\s\S]*-Force/i,
  /\brm\b[\s\S]*\s-rf\b/i
];

export function assertSafeCommand(command: string): void {
  const hit = blockedCommandPatterns.find((pattern) => pattern.test(command));
  if (hit) throw new Error(`Command blocked by safety policy: ${hit}`);
}
