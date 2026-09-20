import type {
  CapabilityScope,
  ToolRisk
} from "../capability/types.js";
import type { ErrorCategory } from "../runtime/errors.js";

export type LiveActivityState = "running" | "succeeded" | "failed";

export type LiveActivityRecord = {
  id: string;
  capability: string;
  risk: ToolRisk;
  scope: CapabilityScope;
  workspaceId: string;
  summary: string;
  detail?: string;
  state: LiveActivityState;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  errorCategory?: ErrorCategory;
};

export class LiveActivityStore {
  readonly #limit: number;
  readonly #records = new Map<string, LiveActivityRecord>();

  constructor(limit = 200) {
    this.#limit = Math.max(20, Math.min(Math.trunc(limit), 1000));
  }

  upsert(record: LiveActivityRecord): void {
    this.#records.set(record.id, { ...record });
    if (this.#records.size <= this.#limit) return;

    const ordered = [...this.#records.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.#records.size > this.#limit && ordered.length > 0) {
      this.#records.delete(ordered.shift()!.id);
    }
  }

  recent(limit = 60): LiveActivityRecord[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 200));
    return [...this.#records.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, bounded)
      .map((record) => ({ ...record }));
  }
}

const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;
const SECRET_CLI_ARGUMENT =
  /--?(password|passwd|pwd|token|secret|api[_-]?key|authorization)\s+(?:"[^"]*"|'[^']*'|\S+)/gi;

function shorten(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? normalized.slice(0, max) + "…"
    : normalized;
}

export function sanitizeShellCommand(command: string): string {
  return shorten(
    command
      .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=<redacted>`)
      .replace(SECRET_CLI_ARGUMENT, (_match, key: string) => `--${key} <redacted>`)
      .replace(BEARER, "Bearer <redacted>")
  );
}

function stringValue(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

export function summarizeToolInput(
  capability: string,
  input: unknown
): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;

  switch (capability) {
    case "fs_read":
    case "fs_list":
    case "fs_write":
    case "apply_patch":
    case "read_file":
    case "list_directory":
      return stringValue(value, "path");

    case "git_add": {
      const paths = Array.isArray(value.paths)
        ? value.paths.filter((item): item is string => typeof item === "string")
        : [];
      if (paths.length === 0) return undefined;
      const visible = paths.slice(0, 6).join(", ");
      return paths.length > 6
        ? `${visible} (+${paths.length - 6})`
        : visible;
    }

    case "git_branch": {
      const action = stringValue(value, "action");
      const name = stringValue(value, "name");
      return [action, name].filter(Boolean).join(" ");
    }

    case "git_commit":
      return "local commit";

    case "git_push": {
      const remote = stringValue(value, "remote") ?? "origin";
      return `remote=${remote}`;
    }

    case "command_run":
      return stringValue(value, "action");

    case "shell_run": {
      const command = stringValue(value, "command");
      const cwd = stringValue(value, "cwd");
      const parts = command ? [sanitizeShellCommand(command)] : [];
      if (cwd) parts.push(`cwd=${shorten(cwd, 100)}`);
      return parts.join(" · ");
    }

    case "workspace_switch":
      return stringValue(value, "id");

    case "mcp_list_tools":
    case "mcp_status":
      return stringValue(value, "server");

    case "mcp_call_tool": {
      const server = stringValue(value, "server");
      const tool = stringValue(value, "tool");
      return [server, tool].filter(Boolean).join(" / ");
    }

    case "runtime_restart":
      return "P05 runtime";

    default: {
      const hidden = /content|text|command|message|input|argument|token|secret|password|key|sha/i;
      const parts: string[] = [];
      for (const [key, raw] of Object.entries(value)) {
        if (hidden.test(key) || parts.length >= 4) continue;
        if (typeof raw === "string") {
          parts.push(`${key}=${shorten(raw, 80)}`);
        } else if (typeof raw === "number" || typeof raw === "boolean") {
          parts.push(`${key}=${String(raw)}`);
        }
      }
      return parts.length ? parts.join(" · ") : undefined;
    }
  }
}
