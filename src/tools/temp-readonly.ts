/**
 * TEMPORARY read-only capability layer — TMP-R01 … TMP-R06.
 *
 * Why this file exists: a remote client needs to read this project's documents and source to
 * review them. That is a read-only need, so this layer deliberately offers exactly two read
 * operations and nothing else — no write, no delete, no move, no execute path exists here at
 * all (TMP-R06), and nothing in this module spawns a process or opens a file for writing.
 *
 * It is NOT the permanent permission model. It is a stop-gap that is deleted rather than
 * extended: the Security Broker described in
 * `D:\Project_Git\_p05_deploy\BOOTSTRAP_V1_DESIGN.md` (with policy, approval and audit)
 * replaces it. Two consequences are deliberate:
 *   - the layer is off unless `P05_TEMP_READONLY_ROOT` is set, so the default install keeps
 *     the documented TASK-001 surface (`device_info` + `ping`) untouched;
 *   - the temporary root can only ever *narrow* `REMOTE_AGENT_ALLOWED_ROOTS`; a value outside
 *     those roots aborts startup (src/config.ts), never widens reach.
 *
 * Every path passes the existing hardened guard first (`assertAccessiblePath`: path shape,
 * allowed root, protected names such as `.git`/`.p05`/`.env`, write-side code-execution
 * paths, and the resolved real path), then the temporary root check, then a stricter
 * credential filter — so this layer can only refuse more than the guard already does.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { TEMP_READONLY_ROOT_ENV } from "../env.js";
import { assertAccessiblePath, protectionReason } from "../security.js";

/** TMP-R05: the remote gets a bounded read, not a file transfer channel. */
export const TEMP_READONLY_MAX_BYTES = 1024 * 1024;

/** A listing is a discovery aid, not a full inventory of a huge tree. */
export const TEMP_READONLY_MAX_ENTRIES = 1000;

/**
 * TMP-R04: credential-shaped names this layer refuses on top of what src/security.ts already
 * protects. Patterns are anchored on separators so an ordinary source file whose name merely
 * contains a word like "token" (for example `tokenizer.ts`) stays readable.
 */
const secretExtensions = new Set([".key", ".pem", ".pfx", ".p12", ".kdbx", ".jks", ".keystore", ".ppk", ".asc", ".crt", ".der"]);

const secretBasenamePatterns = [
  /(^|[._-])tokens?([._-]|$)/,
  /(^|[._-])secrets?([._-]|$)/,
  /(^|[._-])credentials?([._-]|$)/,
  /password/,
  /passwd/,
  /api[_-]?key/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /\.ppk$/
];

const secretSegments = new Set(["secrets", "credentials", ".secrets"]);

/** Templates that document variable names only; src/security.ts draws the same line. */
const envTemplates = new Set([".env.example", ".env.sample", ".env.template"]);

export function secretReason(resolvedPath: string): string | undefined {
  const segments = resolvedPath.split(path.sep).filter(Boolean);
  const secretSegment = segments.find((segment) => secretSegments.has(segment.toLowerCase()));
  if (secretSegment) return `path segment "${secretSegment.toLowerCase()}" may hold credentials`;

  const base = path.basename(resolvedPath).toLowerCase();
  if (envTemplates.has(base)) return undefined;
  if (base === ".env" || base.startsWith(".env.")) return `"${base}" may hold secrets`;
  if (secretExtensions.has(path.extname(base))) return `"${path.extname(base)}" may hold private keys`;

  const hit = secretBasenamePatterns.find((pattern) => pattern.test(base));
  if (hit) return `"${base}" looks like a credential or token file`;

  return undefined;
}

function activeRoot(): string {
  const root = config.tempReadonlyRoot;
  if (!root) {
    throw new Error(
      "The temporary read-only layer is not enabled on this machine " +
        `(set ${TEMP_READONLY_ROOT_ENV} to an absolute path inside REMOTE_AGENT_ALLOWED_ROOTS).`
    );
  }
  return root;
}

function withinTempRoot(target: string, root: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const candidate = normalize(target);
  const resolvedRoot = normalize(root);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);
}

/**
 * Refusals echo the caller's own input and never the temporary root or a link target: those
 * would let a remote client enumerate the machine for free, which is the same rule the
 * existing fs tools follow.
 */
async function guardedReadPath(input: string): Promise<string> {
  const root = activeRoot();

  const safe = await assertAccessiblePath(input, "read");
  if (!withinTempRoot(safe, root)) {
    throw new Error(`Path refused: ${input} is outside the temporary read-only root.`);
  }

  let real: string;
  try {
    real = await fs.realpath(safe);
  } catch {
    throw new Error("Path refused: it does not exist.");
  }
  if (!withinTempRoot(real, root)) {
    throw new Error(`Path refused: ${input} (a link resolves outside the temporary read-only root).`);
  }

  const reason = secretReason(real);
  if (reason) throw new Error(`Path refused: ${input} (${reason}).`);

  return real;
}

/** TMP-R01 read_file: UTF-8 text only, bounded size, credential-shaped paths refused. */
export async function readTempFile(input: string): Promise<string> {
  const real = await guardedReadPath(input);

  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    throw new Error("Not found.");
  }
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > TEMP_READONLY_MAX_BYTES) {
    throw new Error(`File exceeds the temporary read limit (${TEMP_READONLY_MAX_BYTES} bytes).`);
  }

  const buffer = await fs.readFile(real);
  if (buffer.includes(0)) throw new Error("Refusing to return a binary file.");
  return buffer.toString("utf8");
}

/**
 * TMP-R01 list_directory: entry names only (the caller supplied the directory, so echoing its
 * own string discloses nothing), credential-shaped and protected entries withheld with a count
 * so a reader can tell that something was withheld rather than silently missing.
 */
export async function listTempDirectory(input: string): Promise<string[]> {
  const real = await guardedReadPath(input);

  const entries = await fs.readdir(real, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const lines: string[] = [];
  let withheld = 0;

  for (const entry of entries) {
    const child = path.join(real, entry.name);
    if (protectionReason(child) || secretReason(child)) {
      withheld += 1;
      continue;
    }
    lines.push(`${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
    if (lines.length >= TEMP_READONLY_MAX_ENTRIES) {
      lines.push(`[TRUNCATED] listing stopped at ${TEMP_READONLY_MAX_ENTRIES} entries`);
      break;
    }
  }

  if (withheld > 0) {
    lines.push(`[SKIP] ${withheld} protected or credential-like ${withheld === 1 ? "entry" : "entries"} not listed`);
  }

  return lines;
}
