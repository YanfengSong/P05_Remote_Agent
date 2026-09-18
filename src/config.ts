import path from "node:path";

/**
 * Default roots are only a fallback for an unset variable. A variable that IS set
 * but carries no usable entry is a configuration error and aborts startup: rules 3.4
 * (fail closed) and section 8.1 both require the operator to state the roots, and a
 * silent fallback would confine the agent to whatever directory it happened to start
 * in.
 */
const DEFAULT_ROOTS = ["F:\\Project_Git"];

function parseEntries(raw: string): string[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseAllowedRoots(raw: string | undefined): string[] {
  if (raw === undefined) return DEFAULT_ROOTS.map((root) => path.resolve(root));

  const entries = parseEntries(raw);
  if (entries.length === 0) {
    throw new Error(
      "REMOTE_AGENT_ALLOWED_ROOTS is set but contains no usable path. " +
        `Set it to the absolute root(s) this agent may touch, semicolon-separated ` +
        `(for example F:\\Project_Git). Refusing to start with an undefined allowed root.`
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

const allowedRoots = parseAllowedRoots(process.env.REMOTE_AGENT_ALLOWED_ROOTS);

export const config = {
  name: "p05-remote-agent",
  version: "0.2.0",
  /** Raw value; validated fail-closed by src/policy/tool-profile.ts. Unset means "discovery". */
  toolProfile: process.env.P05_TOOL_PROFILE,
  allowedRoots,
  defaultCwd: parseDefaultCwd(process.env.REMOTE_AGENT_DEFAULT_CWD, allowedRoots),
  shellTimeoutMs: Number(process.env.REMOTE_AGENT_SHELL_TIMEOUT_MS ?? "120000"),
  maxReadBytes: Number(process.env.REMOTE_AGENT_MAX_READ_BYTES ?? String(2 * 1024 * 1024)),
  maxWriteBytes: Number(process.env.REMOTE_AGENT_MAX_WRITE_BYTES ?? String(2 * 1024 * 1024))
};
