import { createHash } from "node:crypto";
import type { CoreState } from "./core/state.js";

export type LifecycleRestartState = "ACK_PENDING" | "RESTARTING" | "SUCCEEDED";
export interface LifecycleRestartRecord {
  lifecycleId: string;
  action: "restart";
  state: LifecycleRestartState;
  requestedGeneration: number;
  requestedCoreInstanceId: string;
  requestedAt: string;
  dispatchAt?: string;
  completedGeneration?: number;
  completedCoreInstanceId?: string;
  completedAt?: string;
  health?: {
    liveness: boolean;
    mode: string;
    protectionVerified: boolean;
    executionAvailable: boolean;
  };
}
export interface VersionedLifecycleRestart {
  version: number;
  record: LifecycleRestartRecord;
}

const prefix = "service:lifecycle:";
const lifecycleIdPattern = /^restart-[a-f0-9]{32}$/;

function key(lifecycleId: string): string {
  if (!lifecycleIdPattern.test(lifecycleId)) throw new Error("INVALID_LIFECYCLE_ID");
  return prefix + lifecycleId;
}

export function lifecycleIdFor(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 || /[\x00-\x1f\x7f]/.test(idempotencyKey)) {
    throw new Error("INVALID_LIFECYCLE_IDEMPOTENCY_KEY");
  }
  return "restart-" + createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}

export function beginLifecycleRestart(state: CoreState, idempotencyKey: string): VersionedLifecycleRestart {
  const lifecycleId = lifecycleIdFor(idempotencyKey);
  const existing = state.readVersioned<LifecycleRestartRecord>(key(lifecycleId));
  if (existing) return { version: existing.version, record: existing.value };
  const record: LifecycleRestartRecord = {
    lifecycleId, action: "restart", state: "ACK_PENDING",
    requestedGeneration: state.identity.instanceGeneration,
    requestedCoreInstanceId: state.identity.coreInstanceId,
    requestedAt: new Date().toISOString()
  };
  if (!state.compareAndSet(key(lifecycleId), null, record)) {
    const raced = state.readVersioned<LifecycleRestartRecord>(key(lifecycleId));
    if (!raced) throw new Error("LIFECYCLE_STATE_RACE");
    return { version: raced.version, record: raced.value };
  }
  const stored = state.readVersioned<LifecycleRestartRecord>(key(lifecycleId))!;
  return { version: stored.version, record: stored.value };
}

export function claimLifecycleRestart(state: CoreState, lifecycleId: string): LifecycleRestartRecord | null {
  const current = state.readVersioned<LifecycleRestartRecord>(key(lifecycleId));
  if (!current || current.value.state !== "ACK_PENDING") return null;
  const next: LifecycleRestartRecord = { ...current.value, state: "RESTARTING", dispatchAt: new Date().toISOString() };
  if (!state.compareAndSet(key(lifecycleId), current.version, next)) return null;
  return state.readVersioned<LifecycleRestartRecord>(key(lifecycleId))!.value;
}

export function lifecycleRestartStatus(state: CoreState, lifecycleId: string): LifecycleRestartRecord | undefined {
  return state.readVersioned<LifecycleRestartRecord>(key(lifecycleId))?.value;
}

export function completeLifecycleRestart(state: CoreState, lifecycleId: string, health: LifecycleRestartRecord["health"]): LifecycleRestartRecord {
  const current = state.readVersioned<LifecycleRestartRecord>(key(lifecycleId));
  if (!current || current.value.state !== "RESTARTING") throw new Error("LIFECYCLE_NOT_RESTARTING");
  if (current.value.requestedGeneration >= state.identity.instanceGeneration) throw new Error("LIFECYCLE_GENERATION_NOT_ADVANCED");
  const next: LifecycleRestartRecord = {
    ...current.value, state: "SUCCEEDED",
    completedGeneration: state.identity.instanceGeneration,
    completedCoreInstanceId: state.identity.coreInstanceId,
    completedAt: new Date().toISOString(),
    health
  };
  if (!state.compareAndSet(key(lifecycleId), current.version, next)) throw new Error("LIFECYCLE_COMPLETION_CONFLICT");
  return state.readVersioned<LifecycleRestartRecord>(key(lifecycleId))!.value;
}