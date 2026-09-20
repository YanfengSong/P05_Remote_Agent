import type { SessionState } from "../session/types.js";

export type AgentSessionState = SessionState;

export type AgentProviderView = {
  id: string;
  label: string;
  pluginId: string;
  enabled: boolean;
  activeForWorkspace: boolean;
  writeAccess: boolean;
};

export type AgentSessionView = {
  id: string;
  providerId: string;
  workspaceId: string;
  state: AgentSessionState;
  actorId: string;
  isolationId?: string;
  isolationKind?: "workspace" | "worktree" | "session-root";
  createdAt: string;
  startedAt?: string;
  lastActivityAt: string;
  finishedAt?: string;
  recoveryHint: "none" | "inspect" | "retry";
  taskCount: number;
};

export type AgentOutputView = {
  agentSessionId: string;
  state: AgentSessionState;
  events: Array<{
    seq: number;
    channel: string;
    text: string;
    timestamp: string;
  }>;
  nextCursor: number;
  truncated: boolean;
};
