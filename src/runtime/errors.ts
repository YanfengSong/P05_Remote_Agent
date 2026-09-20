export const ERROR_CATEGORIES = [
  "policy",
  "timeout",
  "process",
  "tool",
  "config",
  "interrupted",
  "unknown"
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof AuthorizationError) return "policy";

  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === "ETIMEDOUT" || /\btimeout\b|timed out/i.test(message)) return "timeout";
  if (/Git command failed|Process failed|ACTION .* FAILED|spawn|child process/i.test(message)) return "process";
  if (/P05_WORKSPACES_JSON|REMOTE_AGENT_|P05_TOOL_PROFILE|configuration|config:/i.test(message)) return "config";
  if (error instanceof Error) return "tool";
  return "unknown";
}