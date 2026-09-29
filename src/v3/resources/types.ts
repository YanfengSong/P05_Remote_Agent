export type ResourceMode = "shared" | "serialized-operation" | "exclusive-session";
export interface ResourceDescriptor {
  resourceId: string;
  kind: string;
  stablePhysicalIdentity: string;
  mode: ResourceMode;
  capacity: number;
  adapter: string;
}
export interface LeaseOwner {
  slotId: string;
  runId: string;
  executorId: string;
  executorBootId: string;
}
export interface LeaseCredential {
  leaseId: string;
  fencingEpoch: number;
  token: string;
}
export interface ResourceLease extends LeaseCredential {
  hostId: string;
  resourceId: string;
  requestId: string;
  owner: LeaseOwner;
  mode: ResourceMode;
  state: "ACTIVE" | "QUARANTINED" | "RELEASED";
  acquiredAt: number;
  expiresAt: number;
  releasedAt: number | null;
  quarantineReason: string | null;
}
export type LeaseView = Omit<ResourceLease, "token">;
export type ResourceRequestState = "WAITING" | "GRANTED" | "BUSY" | "CANCELLED" | "EXPIRED";
export interface ResourceRequest {
  requestId: string;
  owner: LeaseOwner;
  resourceIds: string[];
  ttlMs: number;
  state: ResourceRequestState;
  createdAt: number;
  waitDeadline: number;
  leases: ResourceLease[];
}
export interface AcquireResources {
  owner: LeaseOwner;
  resourceIds: string[];
  ttlMs: number;
  /** Zero means do not queue. Existing request IDs never become a new acquisition. */
  waitMs?: number;
  requestId?: string;
}
export interface RecoveryEvidence {
  kind: "executor-terminated";
  executorId: string;
  executorBootId: string;
  evidenceRef: string;
}
export interface ResourceCoordinatorOptions {
  /** One operator-provisioned, protected local directory per Host. Not caller-selected. */
  stateDir: string;
  hostId: string;
  maxQueue?: number;
  maxLeaseMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  /** Trusted host/broker proof verifier. No verifier means recovery is unavailable. */
  verifyTermination?: (lease: LeaseView, evidence: RecoveryEvidence) => boolean | Promise<boolean>;
}
export class ResourceError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "ResourceError"; }
}
