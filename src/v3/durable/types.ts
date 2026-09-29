export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RunState = 'QUEUED' | 'WAITING_APPROVAL' | 'RUNNING' | 'CANCEL_REQUESTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'EXPIRED' | 'CANCELLED' | 'UNKNOWN';
export interface Owner { principal: string; slotId: string }
/** Supplied by the trusted adapter, never directly by tool arguments. */
export interface ExecutionContext extends Owner { hostId: string; workspaceId: string; workspaceRoot: string; authorizationRevision: string }
export interface CapabilityIdentity { capability: string; capabilityVersion: string; bindingVersion: string }
export interface Run extends CapabilityIdentity {
  executionId: string; context: Readonly<ExecutionContext>; inputDigest: string; intentDigest: string;
  state: RunState; stateVersion: number; createdAt: number; updatedAt: number;
  result: Json | null; error: string | null; approval: Approval | null;
}
export interface Approval { approvalId: string; executionId: string; status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CANCELLED'; decisionVersion: number; expiresAt: number; reason: string }
export interface RunEvent { executionId: string; sequence: number; type: string; at: number; data: Json }
export interface SubmitRequest { capability: string; input: Json; idempotencyKey: string }
export type Authorization = { decision: 'ALLOW' } | { decision: 'DENY'; reason: string } | { decision: 'CONFIRM'; reason: string; expiresAt: number };
export interface Invocation { run: Readonly<Run>; input: Json; signal: AbortSignal }
export interface Capability extends CapabilityIdentity { execute(invocation: Invocation): Promise<Json> }
export interface KernelOptions {
  store: import('./store.js').DurableStore;
  authorize(run: Readonly<Run>, input: Json): Promise<Authorization> | Authorization;
  /** Check current revocations, workspace and binding preconditions even after approval. */
  revalidate(run: Readonly<Run>, input: Json): Promise<boolean> | boolean;
  maxConcurrency?: number;
}
export interface OperatorDecision { approvalId: string; expectedDecisionVersion: number; decision: 'APPROVE' | 'DENY'; actor: string }
export interface StoreHealth { available: boolean; state: 'READY' | 'FAULTED' | 'CLOSED'; faultCode: string | null; lastFailureAt: number | null; schemaVersion: 1; payloadProtection: 'plaintext-local' }
export interface KernelHealth { executionAvailable: boolean; scheduler: 'RUNNING' | 'STOPPED' | 'CLOSED'; activeExecutions: number; faultCode: string | null; storage: StoreHealth }
/** Keep this object private to the authenticated local Operator transport. */
export interface OperatorPort {
  pending(slotId: string, limit?: number): Approval[];
  decide(request: OperatorDecision): Run;
  reconcile(request: { proof: VerifiedReconciliationProof; actor: string }): Run;
}
export interface ReconciliationSnapshot {
  run: Run; input: Json;
  attempt: { id: string; dispatchKey: string; status: 'DISPATCHING' | 'UNCONFIRMED' };
  cancellationRequested: boolean;
}
export interface ReconciliationPlan {
  executionId: string; expectedStateVersion: number; expectedSnapshotDigest: string;
  coreAttemptId: string; coreDispatchKey: string; processDispatchKey: string;
  inputDigest: string; intentDigest: string; bindingVersion: string;
  owner: Owner; outcome: 'SUCCEEDED' | 'FAILED'; result: Json; evidenceDigest: string;
}
declare const reconciliationBrand: unique symbol;
export type VerifiedReconciliationProof = Readonly<ReconciliationPlan> & { readonly [reconciliationBrand]: true };
const reconciliationProofs = new WeakMap<object, ReconciliationPlan>();
/** Trusted adapter only. This object capability cannot be reconstructed from RPC JSON. */
export function issueReconciliationProof(plan: ReconciliationPlan): VerifiedReconciliationProof {
  const copied = JSON.parse(JSON.stringify(plan)) as ReconciliationPlan;
  const proof = Object.freeze(JSON.parse(JSON.stringify(copied))) as VerifiedReconciliationProof;
  reconciliationProofs.set(proof, copied);
  return proof;
}
/** The Store reads its private copy, not mutable nested properties of a proof. */
export function readReconciliationProof(proof: VerifiedReconciliationProof): ReconciliationPlan {
  const plan = proof && typeof proof === 'object' ? reconciliationProofs.get(proof) : undefined;
  if (!plan) throw new DurableError('RECONCILIATION_PROOF_INVALID', 'Only trusted local receipt evidence is accepted');
  return JSON.parse(JSON.stringify(plan)) as ReconciliationPlan;
}
export const TERMINAL = new Set<RunState>(['SUCCEEDED', 'FAILED', 'DENIED', 'EXPIRED', 'CANCELLED', 'UNKNOWN']);
export class DurableError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'DurableError'; } }
/** Core is detaching from an executor; this is not user authorization to cancel external work. */
export class ExecutionDetached extends Error {
  readonly code = 'CORE_DETACHED';
  constructor() { super('Core stopped observing execution'); this.name = 'ExecutionDetached'; }
}
/** A trusted executor cannot confirm the effect outcome. Never convert this into FAILED or retry. */
export class UnconfirmedOutcome extends DurableError {
  constructor(code: string, public readonly evidence: Json = null) { super(code, 'Executor outcome requires reconciliation'); this.name = 'UnconfirmedOutcome'; }
}
/** Confirmed unsuccessful completion, retaining bounded structured executor evidence. */
export class ExecutionFailure extends DurableError {
  constructor(code: string, public readonly evidence: Json = null) { super(code, 'Executor reported unsuccessful completion'); this.name = 'ExecutionFailure'; }
}
