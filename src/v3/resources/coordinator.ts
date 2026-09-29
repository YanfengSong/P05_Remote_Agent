import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResourceError, type AcquireResources, type LeaseCredential, type LeaseOwner, type LeaseView, type RecoveryEvidence, type ResourceCoordinatorOptions, type ResourceDescriptor, type ResourceLease, type ResourceRequest, type ResourceRequestState } from "./types.js";

interface ResourceRow { resource_id: string; descriptor: string; epoch: number; state: "AVAILABLE" | "QUARANTINED" }
interface LeaseRow { lease_id: string; resource_id: string; request_id: string; record: string; state: ResourceLease["state"]; expires_at: number }
interface RequestRow { sequence: number; request_id: string; intent: string; owner: string; resource_ids: string; ttl_ms: number; state: ResourceRequestState; created_at: number; wait_deadline: number }

function identifier(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function assertOwner(owner: LeaseOwner): void {
  if (!owner || ![owner.slotId, owner.runId, owner.executorId, owner.executorBootId].every(identifier)) throw new ResourceError("INVALID_LEASE_OWNER");
}
function ownerKey(owner: LeaseOwner): string { return JSON.stringify([owner.slotId, owner.runId, owner.executorId, owner.executorBootId]); }
function withoutToken(lease: ResourceLease): LeaseView { const { token: _token, ...view } = lease; return view; }
function sameToken(actual: string, candidate: string): boolean {
  if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate) || candidate.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(candidate));
}
function rejectLinks(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = file + suffix;
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new ResourceError("UNTRUSTED_RESOURCE_STATE_PATH");
  }
}

/** Leases coordinate cooperating brokers; they are not OS-level exclusion or authorization.
 * Use one protected directory per Host. All public methods must be behind authenticated Core IPC.
 * In particular, owner fields must come from execution context, not arbitrary client input. */
export class ResourceCoordinator {
  readonly hostId: string;
  readonly stateDir: string;
  private closed = false;

  private constructor(private readonly db: DatabaseSync, private readonly lock: DatabaseSync,
    private readonly options: ResourceCoordinatorOptions, stateDir: string) {
    this.hostId = options.hostId;
    this.stateDir = stateDir;
  }

  static open(options: ResourceCoordinatorOptions): ResourceCoordinator {
    if (!identifier(options.hostId)) throw new ResourceError("INVALID_HOST_ID");
    for (const [value, max] of [[options.maxQueue ?? 128, 10_000], [options.maxLeaseMs ?? 300_000, 86_400_000], [options.maxWaitMs ?? 300_000, 86_400_000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ResourceError("INVALID_RESOURCE_LIMIT");
    }
    if (!path.isAbsolute(options.stateDir) || /^[/\\]{2}/.test(options.stateDir) || path.parse(options.stateDir).root === options.stateDir) throw new ResourceError("INVALID_RESOURCE_STATE_DIRECTORY");
    if (existsSync(options.stateDir) && lstatSync(options.stateDir).isSymbolicLink()) throw new ResourceError("UNTRUSTED_RESOURCE_STATE_PATH");
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const stateDir = realpathSync(options.stateDir);
    if (process.platform !== "win32" && (lstatSync(stateDir).mode & 0o077) !== 0) throw new ResourceError("UNPROTECTED_RESOURCE_STATE_DIRECTORY");
    const lockFile = path.join(stateDir, "coordinator-lock.sqlite");
    const databaseFile = path.join(stateDir, "resources.sqlite");
    rejectLinks(lockFile); rejectLinks(databaseFile);
    let lock: DatabaseSync | undefined;
    let db: DatabaseSync | undefined;
    try {
      lock = new DatabaseSync(lockFile);
      try { lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;"); }
      catch (error) {
        if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw new ResourceError("COORDINATOR_ALREADY_OWNED");
        throw error;
      }
      db = new DatabaseSync(databaseFile);
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resources (resource_id TEXT PRIMARY KEY, physical_identity TEXT NOT NULL UNIQUE, descriptor TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (lease_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS leases_resource_state ON leases(resource_id,state);
        CREATE TABLE IF NOT EXISTS requests (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, intent TEXT NOT NULL, owner TEXT NOT NULL, resource_ids TEXT NOT NULL, ttl_ms INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, wait_deadline INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_queue ON requests(state,sequence);
        CREATE TABLE IF NOT EXISTS recoveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, lease_id TEXT NOT NULL, epoch INTEGER NOT NULL, evidence TEXT NOT NULL, recovered_at INTEGER NOT NULL);
      `);
      const coordinator = new ResourceCoordinator(db, lock, Object.freeze({ ...options }), stateDir);
      coordinator.transaction(() => {
        const host = db!.prepare("SELECT value FROM metadata WHERE key='hostId'").get() as { value: string } | undefined;
        if (host && host.value !== options.hostId) throw new ResourceError("RESOURCE_HOST_MISMATCH");
        db!.prepare("INSERT OR IGNORE INTO metadata VALUES ('hostId', ?)").run(options.hostId);
        // Even a clean Coordinator shutdown does not prove external owners stopped.
        for (const row of db!.prepare("SELECT * FROM leases WHERE state='ACTIVE'").all() as unknown as LeaseRow[]) {
          coordinator.quarantineLease(JSON.parse(row.record) as ResourceLease, "COORDINATOR_RESTART_OWNER_UNVERIFIED");
        }
        coordinator.expireWaiting();
      });
      return coordinator;
    } catch (error) {
      try { db?.close(); } finally { lock?.close(); }
      throw error;
    }
  }

  private now(): number {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new ResourceError("INVALID_COORDINATOR_CLOCK");
    return value;
  }

  private transaction<T>(work: () => T): T {
    if (this.closed) throw new ResourceError("COORDINATOR_CLOSED");
    this.db.exec("BEGIN IMMEDIATE;");
    try { const result = work(); this.db.exec("COMMIT;"); return result; }
    catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  private resource(resourceId: string): ResourceRow {
    const resource = this.db.prepare("SELECT * FROM resources WHERE resource_id=?").get(resourceId) as unknown as ResourceRow | undefined;
    if (!resource) throw new ResourceError("UNKNOWN_RESOURCE");
    return resource;
  }

  registerResource(descriptor: ResourceDescriptor): void {
    if (!identifier(descriptor.resourceId) || !identifier(descriptor.kind) || !identifier(descriptor.adapter)
      || typeof descriptor.stablePhysicalIdentity !== "string" || !descriptor.stablePhysicalIdentity.trim() || descriptor.stablePhysicalIdentity.length > 512
      || !["shared", "serialized-operation", "exclusive-session"].includes(descriptor.mode)
      || !Number.isSafeInteger(descriptor.capacity) || descriptor.capacity < 1 || descriptor.capacity > 1024
      || (descriptor.mode !== "shared" && descriptor.capacity !== 1)) throw new ResourceError("INVALID_RESOURCE_DESCRIPTOR");
    const encoded = JSON.stringify({ resourceId: descriptor.resourceId, kind: descriptor.kind, stablePhysicalIdentity: descriptor.stablePhysicalIdentity, mode: descriptor.mode, capacity: descriptor.capacity, adapter: descriptor.adapter });
    this.transaction(() => {
      const existing = this.db.prepare("SELECT descriptor FROM resources WHERE resource_id=?").get(descriptor.resourceId) as { descriptor: string } | undefined;
      if (existing) {
        if (existing.descriptor !== encoded) throw new ResourceError("RESOURCE_DEFINITION_CHANGED");
        return;
      }
      const alias = this.db.prepare("SELECT resource_id FROM resources WHERE physical_identity=?").get(descriptor.stablePhysicalIdentity);
      if (alias) throw new ResourceError("DUPLICATE_PHYSICAL_RESOURCE");
      this.db.prepare("INSERT INTO resources VALUES (?, ?, ?, 0, 'AVAILABLE')").run(descriptor.resourceId, descriptor.stablePhysicalIdentity, encoded);
    });
  }

  private saveLease(lease: ResourceLease): void {
    this.db.prepare("UPDATE leases SET state=?, expires_at=?, record=? WHERE lease_id=?").run(lease.state, lease.expiresAt, JSON.stringify(lease), lease.leaseId);
  }

  private quarantineLease(lease: ResourceLease, reason: string): void {
    lease.state = "QUARANTINED";
    lease.quarantineReason = reason;
    this.saveLease(lease);
    this.db.prepare("UPDATE resources SET state='QUARANTINED' WHERE resource_id=?").run(lease.resourceId);
  }

  private expireWaiting(): void {
    this.db.prepare("UPDATE requests SET state='EXPIRED' WHERE state='WAITING' AND wait_deadline<=?").run(this.now());
  }

  private expireLeases(): void {
    for (const row of this.db.prepare("SELECT * FROM leases WHERE state='ACTIVE' AND expires_at<=?").all(this.now()) as unknown as LeaseRow[]) {
      this.quarantineLease(JSON.parse(row.record) as ResourceLease, "LEASE_EXPIRED_OWNER_UNVERIFIED");
    }
    this.expireWaiting();
  }

  private available(resourceIds: string[]): boolean {
    return resourceIds.every((id) => {
      const resource = this.resource(id);
      const descriptor = JSON.parse(resource.descriptor) as ResourceDescriptor;
      const count = this.db.prepare("SELECT count(*) AS count FROM leases WHERE resource_id=? AND state!='RELEASED'").get(id) as { count: number };
      return resource.state === "AVAILABLE" && count.count < descriptor.capacity;
    });
  }

  private grant(request: RequestRow): void {
    const now = this.now();
    for (const resourceId of JSON.parse(request.resource_ids) as string[]) {
      const resource = this.resource(resourceId);
      const epoch = resource.epoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new ResourceError("RESOURCE_EPOCH_EXHAUSTED");
      const lease: ResourceLease = {
        leaseId: randomUUID(), token: randomBytes(32).toString("hex"), fencingEpoch: epoch,
        hostId: this.hostId, resourceId, requestId: request.request_id, owner: JSON.parse(request.owner) as LeaseOwner,
        mode: (JSON.parse(resource.descriptor) as ResourceDescriptor).mode, state: "ACTIVE", acquiredAt: now,
        expiresAt: now + request.ttl_ms, releasedAt: null, quarantineReason: null,
      };
      this.db.prepare("UPDATE resources SET epoch=? WHERE resource_id=?").run(epoch, resourceId);
      this.db.prepare("INSERT INTO leases VALUES (?, ?, ?, 'ACTIVE', ?, ?)").run(lease.leaseId, resourceId, request.request_id, lease.expiresAt, JSON.stringify(lease));
    }
    this.db.prepare("UPDATE requests SET state='GRANTED' WHERE request_id=?").run(request.request_id);
  }

  private request(requestId: string, owner: LeaseOwner): RequestRow {
    assertOwner(owner);
    const row = this.db.prepare("SELECT * FROM requests WHERE request_id=?").get(requestId) as unknown as RequestRow | undefined;
    if (!row || ownerKey(JSON.parse(row.owner) as LeaseOwner) !== ownerKey(owner)) throw new ResourceError("REQUEST_NOT_FOUND_OR_NOT_OWNED");
    return row;
  }

  private snapshot(request: RequestRow): ResourceRequest {
    return {
      requestId: request.request_id, owner: JSON.parse(request.owner) as LeaseOwner,
      resourceIds: JSON.parse(request.resource_ids) as string[], ttlMs: request.ttl_ms, state: request.state,
      createdAt: request.created_at, waitDeadline: request.wait_deadline,
      leases: (this.db.prepare("SELECT record FROM leases WHERE request_id=? ORDER BY resource_id").all(request.request_id) as { record: string }[]).map((row) => JSON.parse(row.record) as ResourceLease),
    };
  }

  acquire(input: AcquireResources): ResourceRequest {
    assertOwner(input.owner);
    const waitMs = input.waitMs ?? 0;
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > (this.options.maxLeaseMs ?? 300_000)
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > (this.options.maxWaitMs ?? 300_000)
      || !Array.isArray(input.resourceIds) || input.resourceIds.length < 1 || input.resourceIds.length > 32 || !input.resourceIds.every(identifier)
      || new Set(input.resourceIds).size !== input.resourceIds.length) throw new ResourceError("INVALID_RESOURCE_REQUEST");
    const requestId = input.requestId ?? randomUUID();
    if (!identifier(requestId)) throw new ResourceError("INVALID_RESOURCE_REQUEST_ID");
    const resourceIds = [...input.resourceIds].sort();
    const intent = JSON.stringify({ owner: ownerKey(input.owner), resourceIds, ttlMs: input.ttlMs, waitMs });
    return this.transaction(() => {
      this.expireLeases();
      for (const id of resourceIds) this.resource(id);
      const existing = this.db.prepare("SELECT * FROM requests WHERE request_id=?").get(requestId) as unknown as RequestRow | undefined;
      if (existing) {
        if (existing.intent !== intent) throw new ResourceError("RESOURCE_IDEMPOTENCY_CONFLICT");
        return this.snapshot(existing);
      }
      // Bundle atomicity alone is insufficient if an owner keeps an earlier bundle
      // while queuing for another. Reject hold-and-wait inside the Coordinator.
      if (waitMs > 0 && (this.db.prepare("SELECT record FROM leases WHERE state!='RELEASED'").all() as { record: string }[])
        .some((row) => ownerKey((JSON.parse(row.record) as ResourceLease).owner) === ownerKey(input.owner))) {
        throw new ResourceError("RESOURCE_HOLD_AND_WAIT_FORBIDDEN");
      }
      const waiting = (this.db.prepare("SELECT count(*) AS count FROM requests WHERE state='WAITING'").get() as { count: number }).count;
      const canGrant = waiting === 0 && this.available(resourceIds);
      if (!canGrant && waitMs > 0 && waiting >= (this.options.maxQueue ?? 128)) throw new ResourceError("RESOURCE_QUEUE_FULL");
      const state = canGrant || waitMs > 0 ? "WAITING" : "BUSY";
      const now = this.now();
      this.db.prepare("INSERT INTO requests(request_id,intent,owner,resource_ids,ttl_ms,state,created_at,wait_deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(requestId, intent, JSON.stringify(input.owner), JSON.stringify(resourceIds), input.ttlMs, state, now, now + waitMs);
      if (canGrant) this.grant(this.request(requestId, input.owner));
      return this.snapshot(this.request(requestId, input.owner));
    });
  }

  queryRequest(requestId: string, owner: LeaseOwner): ResourceRequest {
    return this.transaction(() => { this.expireLeases(); return this.snapshot(this.request(requestId, owner)); });
  }

  cancelWait(requestId: string, owner: LeaseOwner): ResourceRequest {
    return this.transaction(() => {
      this.expireLeases();
      const request = this.request(requestId, owner);
      if (request.state === "WAITING") this.db.prepare("UPDATE requests SET state='CANCELLED' WHERE request_id=?").run(requestId);
      else if (request.state === "GRANTED") throw new ResourceError("REQUEST_ALREADY_GRANTED_RELEASE_LEASES");
      return this.snapshot(this.request(requestId, owner));
    });
  }

  /** FIFO queue, atomic all-or-none grants. No waiter holds a partial reservation. */
  pumpQueue(): string[] {
    return this.transaction(() => {
      this.expireLeases();
      const granted: string[] = [];
      for (const request of this.db.prepare("SELECT * FROM requests WHERE state='WAITING' ORDER BY sequence").all() as unknown as RequestRow[]) {
        if (!this.available(JSON.parse(request.resource_ids) as string[])) break;
        this.grant(request);
        granted.push(request.request_id);
      }
      return granted;
    });
  }

  private ownedLease(credential: LeaseCredential, owner: LeaseOwner): ResourceLease {
    assertOwner(owner);
    const row = this.db.prepare("SELECT record FROM leases WHERE lease_id=?").get(credential.leaseId) as { record: string } | undefined;
    const lease = row ? JSON.parse(row.record) as ResourceLease : undefined;
    if (!lease || ownerKey(lease.owner) !== ownerKey(owner) || lease.fencingEpoch !== credential.fencingEpoch || !sameToken(lease.token, credential.token)) throw new ResourceError("INVALID_LEASE_CREDENTIAL");
    return lease;
  }

  private requireActive(lease: ResourceLease): void {
    if (lease.state !== "ACTIVE" || lease.expiresAt <= this.now() || this.resource(lease.resourceId).state !== "AVAILABLE") throw new ResourceError("LEASE_NOT_ACTIVE");
  }

  queryLease(credential: LeaseCredential, owner: LeaseOwner): LeaseView {
    return this.transaction(() => { this.expireLeases(); return withoutToken(this.ownedLease(credential, owner)); });
  }

  /** Brokers must invoke this immediately before resource operations. For shared leases,
   * multiple epochs can remain valid; equality to the resource's latest epoch is incorrect. */
  validateToken(resourceId: string, credential: LeaseCredential, owner: LeaseOwner): LeaseView {
    return this.transaction(() => {
      this.expireLeases();
      const lease = this.ownedLease(credential, owner);
      if (lease.resourceId !== resourceId) throw new ResourceError("RESOURCE_LEASE_MISMATCH");
      this.requireActive(lease);
      return withoutToken(lease);
    });
  }

  renew(credential: LeaseCredential, owner: LeaseOwner, ttlMs: number): LeaseView {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > (this.options.maxLeaseMs ?? 300_000)) throw new ResourceError("INVALID_LEASE_TTL");
    return this.transaction(() => {
      this.expireLeases();
      const lease = this.ownedLease(credential, owner);
      this.requireActive(lease);
      lease.expiresAt = Math.max(lease.expiresAt, this.now() + ttlMs);
      this.saveLease(lease);
      return withoutToken(lease);
    });
  }

  /** Only relinquish after the adapter has stopped using the resource. Expired or
   * quarantined owners cannot clear uncertainty by issuing an ordinary release. */
  release(credential: LeaseCredential, owner: LeaseOwner): LeaseView {
    return this.transaction(() => {
      this.expireLeases();
      const lease = this.ownedLease(credential, owner);
      if (lease.state === "RELEASED") return withoutToken(lease);
      this.requireActive(lease);
      lease.state = "RELEASED";
      lease.releasedAt = this.now();
      this.saveLease(lease);
      return withoutToken(lease);
    });
  }

  /** Trusted maintenance only: quarantine every holder, including shared holders. */
  quarantine(resourceId: string, reason: string): void {
    if (!/^[A-Z0-9_]{1,96}$/.test(reason)) throw new ResourceError("INVALID_QUARANTINE_REASON");
    this.transaction(() => {
      this.resource(resourceId);
      const leases = this.db.prepare("SELECT record FROM leases WHERE resource_id=? AND state!='RELEASED'").all(resourceId) as { record: string }[];
      if (leases.length === 0) throw new ResourceError("NO_RESOURCE_OWNER_TO_RECONCILE");
      for (const row of leases) this.quarantineLease(JSON.parse(row.record) as ResourceLease, reason);
    });
  }

  /** Evidence is accepted only by a configured trusted verifier. Client strings are not proof. */
  async reconcileLease(leaseId: string, expectedEpoch: number, evidence: RecoveryEvidence): Promise<LeaseView> {
    if (!this.options.verifyTermination) throw new ResourceError("RECOVERY_VERIFIER_UNAVAILABLE");
    const lease = this.transaction(() => {
      this.expireLeases();
      const row = this.db.prepare("SELECT record FROM leases WHERE lease_id=?").get(leaseId) as { record: string } | undefined;
      if (!row) throw new ResourceError("UNKNOWN_LEASE");
      const value = JSON.parse(row.record) as ResourceLease;
      if (value.state !== "QUARANTINED" || value.fencingEpoch !== expectedEpoch) throw new ResourceError("STALE_RESOURCE_RECOVERY");
      return value;
    });
    if (evidence.kind !== "executor-terminated" || evidence.executorId !== lease.owner.executorId || evidence.executorBootId !== lease.owner.executorBootId
      || typeof evidence.evidenceRef !== "string" || !evidence.evidenceRef.trim() || evidence.evidenceRef.length > 512) throw new ResourceError("INVALID_RESOURCE_RECOVERY_EVIDENCE");
    if (await this.options.verifyTermination(withoutToken(lease), structuredClone(evidence)) !== true) throw new ResourceError("RESOURCE_RECOVERY_NOT_VERIFIED");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT record FROM leases WHERE lease_id=?").get(leaseId) as { record: string };
      const current = JSON.parse(row.record) as ResourceLease;
      if (current.state !== "QUARANTINED" || current.fencingEpoch !== expectedEpoch) throw new ResourceError("STALE_RESOURCE_RECOVERY");
      current.state = "RELEASED";
      current.releasedAt = this.now();
      this.saveLease(current);
      this.db.prepare("INSERT INTO recoveries(lease_id,epoch,evidence,recovered_at) VALUES (?, ?, ?, ?)").run(leaseId, expectedEpoch, JSON.stringify(evidence), this.now());
      const remaining = this.db.prepare("SELECT count(*) AS count FROM leases WHERE resource_id=? AND state='QUARANTINED'").get(current.resourceId) as { count: number };
      if (remaining.count === 0) this.db.prepare("UPDATE resources SET state='AVAILABLE' WHERE resource_id=?").run(current.resourceId);
      return withoutToken(current);
    });
  }

  /** Trusted local diagnostic API; token secrets are never included. */
  inspect(resourceId: string) {
    return this.transaction(() => {
      this.expireLeases();
      const resource = this.resource(resourceId);
      return {
        hostId: this.hostId, ...JSON.parse(resource.descriptor) as ResourceDescriptor,
        state: resource.state, fencingEpoch: resource.epoch,
        holders: (this.db.prepare("SELECT record FROM leases WHERE resource_id=? AND state!='RELEASED'").all(resourceId) as { record: string }[]).map((row) => withoutToken(JSON.parse(row.record) as ResourceLease)),
        enforcement: "cooperative-adapter-validation" as const, osIsolationEnforced: false,
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.lock.close(); }
  }
}
