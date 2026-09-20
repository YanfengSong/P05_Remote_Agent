import type { CapabilityScope } from "../capability/registry.js";
import type { ErrorCategory } from "../runtime/errors.js";

export const EXECUTION_STATES = ["running", "succeeded", "failed"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const EXECUTION_PHASES = [
  "prepare",
  "authorize",
  "execute",
  "verify",
  "complete"
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export type RecoveryHint = "none" | "retry" | "inspect" | "human";

export type AuditEvent = {
  id: string;
  capability: string;
  scope: CapabilityScope;
  workspaceId: string;
  sessionId?: string;
  actorType?: "interactive" | "agent" | "plugin" | "system";
  actorId?: string;
  taskId?: string;
  state: ExecutionState;
  phase: ExecutionPhase;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  errorCategory?: ErrorCategory;
  recoveryHint: RecoveryHint;
};
