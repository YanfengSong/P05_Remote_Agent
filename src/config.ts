import path from "node:path";
import { VERSION } from "./version.js";

/**
 * Read an environment variable as an own property only.
 *
 * `process.env` inherits from Object.prototype, so a polluted prototype would otherwise
 * make `process.env[name]` answer for a variable that was never set - and here that
 * value decides which roots are reachable and which tool profile is active.
 */
export function readOwnEnv(name: string): string | undefined {
  return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
}

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
  if (raw === undefined) return allowedRoots[0]!;

  const entries = parseEntries(raw);
  if (entries.length === 0) {
    throw new Error(
      "REMOTE_AGENT_DEFAULT_CWD is set but empty. " +
        "Set it to an absolute directory inside an allowed root, or remove it."
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

const allowedRoots = parseAllowedRoots(readOwnEnv("REMOTE_AGENT_ALLOWED_ROOTS"));

export const config = {
  name: "p05-remote-agent",
  version: VERSION,
  /** Raw value; validated fail-closed by src/policy/tool-profile.ts. Unset means "discovery". */
  toolProfile: readOwnEnv("P05_TOOL_PROFILE"),
  allowedRoots,
  defaultCwd: parseDefaultCwd(readOwnEnv("REMOTE_AGENT_DEFAULT_CWD"), allowedRoots),
  shellTimeoutMs: Number(readOwnEnv("REMOTE_AGENT_SHELL_TIMEOUT_MS") ?? "120000"),
  maxReadBytes: Number(readOwnEnv("REMOTE_AGENT_MAX_READ_BYTES") ?? String(2 * 1024 * 1024)),
  maxWriteBytes: Number(readOwnEnv("REMOTE_AGENT_MAX_WRITE_BYTES") ?? String(2 * 1024 * 1024))
};
