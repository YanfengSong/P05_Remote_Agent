import type { ExecutionContext } from "../runtime/context.js";

export const RUN_STATES = [
  "CREATED",
  "READY",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "PAUSED",
  "RECONCILING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type RunRecoveryHint = "none" | "inspect" | "retry" | "human";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RunRecord = {
  id: string;
  kind: string;
  parentRunId?: string;
  context: ExecutionContext;
  state: RunState;
  ownerType: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  recoveryHint: RunRecoveryHint;
  sequence: number;
  domain: Record<string, JsonValue>;
};

export type RunEvent = {
  runId: string;
  sequence: number;
  type: string;
  at: string;
  payload: Record<string, JsonValue>;
};

export type RunFilter = {
  kind?: string;
  state?: RunState;
  workspaceId?: string;
  limit?: number;
};

export type IsolationStateRecord = {
  id: string;
  workspaceId: string;
  ownerActorType: string;
  ownerActorId: string;
  mode: string;
  state: string;
  baseCommit?: string;
  reconciledCommit?: string;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
};
