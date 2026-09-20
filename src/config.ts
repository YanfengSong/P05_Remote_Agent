import path from "node:path";
import { VERSION } from "./version.js";
import { TEMP_READONLY_ROOT_ENV, readOwnEnv } from "./env.js";

// Re-exported so existing importers keep working; the implementation lives in src/env.ts, which
// has no import-time side effects (see that file's header for why that matters).
export { readOwnEnv };

function parseEntries(raw: string): string[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * There is deliberately no default root.
 *
 * A built-in root would be a machine-specific default: it names one developer's drive,
 * so on every other machine it either refuses everything or frees a directory nobody
 * chose. Rules 3.4 (fail closed) and section 8.1 of the execution plan require the
 * operator to state the roots, so an unset variable aborts startup exactly like a set
 * but unusable one.
 */
export function parseAllowedRoots(raw: string | undefined): string[] {
  if (raw === undefined) {
    throw new Error(
      "REMOTE_AGENT_ALLOWED_ROOTS is not set. This agent ships no default root: state the " +
        "absolute root(s) it may touch, semicolon-separated " +
        "(for example C:\\Projects). Refusing to start without an explicit allowed root."
    );
  }

  const entries = parseEntries(raw);
  if (entries.length === 0) {
    throw new Error(
      "REMOTE_AGENT_ALLOWED_ROOTS is set but contains no usable path. " +
        `Set it to the absolute root(s) this agent may touch, semicolon-separated ` +
        `(for example C:\\Projects). Refusing to start with an undefined allowed root.`
    );
  }

  const relative = entries.filter((entry) => !path.isAbsolute(entry));
  if (relative.length > 0) {
    throw new Error(
      `REMOTE_AGENT_ALLOWED_ROOTS entries must be absolute paths; got: ${relative.join(", ")}. ` +
        "A relative entry would silently resolve against the process working directory."
    );
  }

  return entries.map((entry) => path.resolve(entry));
}

export function parseDefaultCwd(raw: string | undefined, allowedRoots: string[]): string {
  // Unset, empty and whitespace-only all mean "use the first root the operator already
  // authorised". This cannot widen access: the root list is explicit and required, so the
  // fallback is one of the roots that was just stated, not a built-in machine path. It is
  // also the documented install path - copy .env.example, fill in the root, leave this
  // line blank - so refusing an empty value here made the example configuration
  // unstartable.
  if (raw === undefined || raw.trim() === "") return allowedRoots[0]!;

  const entries = parseEntries(raw);
  if (entries.length === 0) {
    // Something was written but holds no usable path (e.g. ";"): that is a typo, not an
    // instruction to fall back, so it is refused like the roots parser refuses it.
    throw new Error(
      "REMOTE_AGENT_DEFAULT_CWD is set but contains no usable path. " +
        "Set it to an absolute directory inside an allowed root, or leave it blank to use the first root."
    );
  }

  const cwd = entries[0]!;
  if (!path.isAbsolute(cwd)) {
    throw new Error(
      `REMOTE_AGENT_DEFAULT_CWD must be an absolute path; got: ${cwd}. ` +
        "A relative value would silently resolve against the process working directory."
    );
  }

  const resolved = path.resolve(cwd);
  const inside = allowedRoots.some((root) => {
    const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    return normalize(resolved) === normalize(root) || normalize(resolved).startsWith(normalize(root) + path.sep);
  });
  if (!inside) {
    throw new Error(
      `REMOTE_AGENT_DEFAULT_CWD (${resolved}) is outside the allowed roots (${allowedRoots.join("; ")}).`
    );
  }

  return resolved;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const resolvedCandidate = normalize(candidate);
  const resolvedRoot = normalize(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

/**
 * Temporary read-only capability layer (TMP-R01..TMP-R06, see docs/adr/ADR-0006).
 *
 * Unset or blank turns the layer off: the two temporary tools stay declared but are never
 * registered, so the TASK-001 discovery contract (`device_info` + `ping` only) still holds
 * unless an operator opts in on this machine.
 *
 * A relative value, or one outside the allowed roots, aborts startup instead of being
 * ignored: this value decides what a remote client may read, so a typo must not silently
 * either widen the reachable area or narrow it to something meaningless.
 */
export function parseTempReadonlyRoot(raw: string | undefined, allowedRoots: string[]): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  const candidate = raw.trim();
  if (!path.isAbsolute(candidate)) {
    throw new Error(
      `P05_TEMP_READONLY_ROOT must be an absolute path; got: ${candidate}. ` +
        "Refusing to start rather than guess which directory that names."
    );
  }

  const resolved = path.resolve(candidate);
  if (!allowedRoots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error(
      `P05_TEMP_READONLY_ROOT (${resolved}) is outside the allowed roots (${allowedRoots.join("; ")}). ` +
        "The temporary layer may only narrow what this agent can reach, never widen it."
    );
  }

  return resolved;
}

const allowedRoots = parseAllowedRoots(readOwnEnv("REMOTE_AGENT_ALLOWED_ROOTS"));

export const config = {
  name: "p05-remote-agent",
  version: VERSION,
  /** Raw value; validated fail-closed by src/policy/tool-profile.ts. Unset means "discovery". */
  toolProfile: readOwnEnv("P05_TOOL_PROFILE"),
  allowedRoots,
  defaultCwd: parseDefaultCwd(readOwnEnv("REMOTE_AGENT_DEFAULT_CWD"), allowedRoots),
  /** Temporary read-only layer root; undefined means the layer is off (TMP-R01). */
  tempReadonlyRoot: parseTempReadonlyRoot(readOwnEnv(TEMP_READONLY_ROOT_ENV), allowedRoots),
  shellTimeoutMs: Number(readOwnEnv("REMOTE_AGENT_SHELL_TIMEOUT_MS") ?? "120000"),
  maxReadBytes: Number(readOwnEnv("REMOTE_AGENT_MAX_READ_BYTES") ?? String(2 * 1024 * 1024)),
  maxWriteBytes: Number(readOwnEnv("REMOTE_AGENT_MAX_WRITE_BYTES") ?? String(2 * 1024 * 1024))
};
