import path from "node:path";

const defaultRoots = [
  "F:\\Project_Git"
];

export const config = {
  name: "p05-remote-agent",
  version: "0.2.0",
  /** Raw value; validated fail-closed by src/policy/gate.ts. Unset means "safe". */
  toolProfile: process.env.P05_TOOL_PROFILE,
  allowedRoots: (process.env.REMOTE_AGENT_ALLOWED_ROOTS ?? defaultRoots.join(";"))
    .split(";")
    .map((p) => path.resolve(p.trim()))
    .filter(Boolean),
  defaultCwd: path.resolve(process.env.REMOTE_AGENT_DEFAULT_CWD ?? "F:\\Project_Git"),
  shellTimeoutMs: Number(process.env.REMOTE_AGENT_SHELL_TIMEOUT_MS ?? "120000"),
  maxReadBytes: Number(process.env.REMOTE_AGENT_MAX_READ_BYTES ?? String(2 * 1024 * 1024)),
  maxWriteBytes: Number(process.env.REMOTE_AGENT_MAX_WRITE_BYTES ?? String(2 * 1024 * 1024))
};
