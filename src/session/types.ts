import type { ExecutionContext } from "../runtime/context.js";

export const SESSION_STATES = [
  "created",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "interrupted"
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export type SessionRecoveryHint = "none" | "inspect" | "retry";

export type SessionAttribute = string | number | boolean | null;

export type SessionRecord = {
  id: string;
  kind: string;
  driverId: string;
  context: ExecutionContext;
  state: SessionState;
  createdAt: string;
  startedAt?: string;
  lastActivityAt: string;
  finishedAt?: string;
  recoveryHint: SessionRecoveryHint;
  attributes: Record<string, SessionAttribute>;
};

export type SessionEvent = {
  seq: number;
  channel: string;
  text: string;
  timestamp: string;
};

export type SessionEventPage = {
  sessionId: string;
  events: SessionEvent[];
  nextCursor: number;
  truncated: boolean;
};
