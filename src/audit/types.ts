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

export type AuditSource =
  | "runtime-mcp"
  | "http-reviewer"
  | "operator"
  | "internal";

export type AuditTransport =
  | "stdio"
  | "streamable-http"
  | "local-http"
  | "internal";

export type AuditAttribution = {
  source: AuditSource;
  transport: AuditTransport;
  runtimeSlot?: "A" | "B";
  principal?: string;
  clientName?: string;
  clientVersion?: string;
};

export type AuditEvent = {
  id: string;
  capability: string;
  scope: CapabilityScope;
  workspaceId: string;
  source?: AuditSource;
  transport?: AuditTransport;
  runtimeSlot?: "A" | "B";
  principal?: string;
  clientName?: string;
  clientVersion?: string;
  state: ExecutionState;
  phase: ExecutionPhase;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  errorCategory?: ErrorCategory;
  recoveryHint: RecoveryHint;
};
