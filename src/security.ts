import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function normalizeForCompare(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type Access = "read" | "write";

function containmentProblem(resolved: string): string | undefined {
  const candidate = normalizeForCompare(resolved);
  const allowed = config.allowedRoots.some((root) => {
    const normalizedRoot = normalizeForCompare(root);
    return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
  });
  return allowed ? undefined : "is outside the allowed roots";
}

/**
 * Refusal messages are returned to a remote client, so they echo the caller's own input
 * and never the resolved path, the process working directory or a link target: those
 * would let the remote enumerate the machine for free.
 */
export function assertAllowedPath(input: string): string {
  const resolved = path.resolve(input);
  const problem = containmentProblem(resolved);
  if (problem) throw new Error(`Path refused: ${input} ${problem}.`);
  return resolved;
}

/**
 * Reject path spellings whose meaning a string comparison cannot reason about.
 *
 * These are not style preferences: each one changes which file the OS actually
 * touches while leaving the string looking harmless.
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

export function assertPathShape(input: string, access: Access): string {
  const problem = shapeProblem(input);
  if (problem) throw new Error(`Path refused for ${access}: ${input} (${problem}).`);
  return path.resolve(input);
}

/**
 * Paths that stay off-limits even inside an allowed root.
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
 * Paths a write must never touch even inside an allowed root, because each one turns a
 * text write into code that runs later with no further tool call: a dependency or build
 * artefact this agent itself loads, or a manifest whose scripts or tasks execute on the
 * next install or workspace open. Reads stay allowed — a build artefact holds no secret.
 */
const writeForbiddenPathSegments = new Set(["node_modules", "dist", ".vscode"]);

const writeForbiddenBasenames = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".mcp.json",
  ".gitmodules"
]);

export function writeProtectionReason(resolvedPath: string): string | undefined {
  const segments = resolvedPath.split(path.sep).filter(Boolean).map(canonicalSegment);
  const segment = segments.find((entry) => writeForbiddenPathSegments.has(entry));
  if (segment) return `"${segment}" holds code this agent loads, so it is read-only`;

  const base = canonicalSegment(path.basename(resolvedPath));
  if (writeForbiddenBasenames.has(base)) return `"${base}" can execute code on the next build or install`;

  return undefined;
}

/**
 * Canonicalise `target`, following symlinks, junctions and 8.3 short names.
 *
 * The first component that exists must canonicalise. If it cannot - a dangling junction
 * whose target does not exist - this reports `danglingLink` and the caller refuses.
 * Falling back to the unresolved path here would make the real path equal the requested
 * path and silently skip the containment check below, which is exactly how a dangling
 * junction used to let a write land outside the allowed roots.
 */
async function resolveRealPath(target: string): Promise<{ real: string; danglingLink: boolean }> {
  let current = target;
  const pending: string[] = [];

  for (;;) {
    let exists = true;
    try {
      await fs.lstat(current);
    } catch {
      exists = false;
    }

    if (exists) {
      try {
        const real = await fs.realpath(current);
        return { real: pending.length === 0 ? real : path.join(real, ...pending.reverse()), danglingLink: false };
      } catch {
        return { real: current, danglingLink: true };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return { real: target, danglingLink: false }; // nothing on this path exists at all
    pending.push(path.basename(current));
    current = parent;
  }
}

/**
 * Guard for the filesystem tools: path shape, allowed root, protected names, write-side
 * code-execution paths, and the resolved real path.
 *
 * Residual risk, documented rather than papered over: `realpath` cannot see hard links,
 * and a TOCTOU window remains between this check and the caller's open().
 */
export async function assertAccessiblePath(input: string, access: Access): Promise<string> {
  const resolved = assertAllowedPath(assertPathShape(input, access));

  const directReason = protectionReason(resolved);
  if (directReason) throw new Error(`Path refused for ${access}: ${input} (${directReason}).`);
  if (access === "write") {
    const writeReason = writeProtectionReason(resolved);
    if (writeReason) throw new Error(`Path refused for ${access}: ${input} (${writeReason}).`);
  }

  const { real, danglingLink } = await resolveRealPath(resolved);
  if (danglingLink) {
    throw new Error(`Path refused for ${access}: ${input} (a link in this path points at something that does not exist).`);
  }

  if (normalizeForCompare(real) !== normalizeForCompare(resolved)) {
    const outside = containmentProblem(real);
    const onProtected = outside ? undefined : protectionReason(real) ?? (access === "write" ? writeProtectionReason(real) : undefined);
    if (outside || onProtected) {
      const detail = outside ? "outside the allowed roots" : `onto a protected path (${onProtected})`;
      throw new Error(`Path refused for ${access}: ${input} (a link resolves ${detail}).`);
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

/**
 * A small destructive-command blocklist. This is a guard rail against accidents, NOT a
 * security boundary: option order, aliases, `rd /s /q`, `cmd /c del /f /s /q`, cmdlet
 * name obfuscation and `Stop-Computer` all pass (TASK-009 owns the real rework).
 */
export function assertSafeCommand(command: string): void {
  const hit = blockedCommandPatterns.find((pattern) => pattern.test(command));
  if (hit) throw new Error(`Command blocked by safety policy: ${hit}`);
}
