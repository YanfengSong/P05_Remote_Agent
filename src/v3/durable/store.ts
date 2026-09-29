import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DurableError, readReconciliationProof, type ReconciliationSnapshot, type VerifiedReconciliationProof, type Approval, type CapabilityIdentity, type ExecutionContext, type Json, type OperatorDecision, type Owner, type Run, type RunEvent, type RunState, type StoreHealth } from './types.js';

/** Local trusted-host storage. Input/result payloads are plaintext, not an encrypted secret store. */
export function canonical(value: Json, depth = 0): string {
  if (depth > 64) throw new DurableError('INVALID_INPUT', 'JSON nesting exceeds 64');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
  throw new DurableError('INVALID_INPUT', 'Expected finite JSON values');
}
export function encode(value: Json): string { const s = canonical(value); if (Buffer.byteLength(s) > 1024 * 1024) throw new DurableError('PAYLOAD_LIMIT', 'Payload exceeds 1 MiB'); return s; }
export function digest(value: Json): string { return createHash('sha256').update(encode(value)).digest('hex'); }
function bounded(value: number, max: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new DurableError('INVALID_LIMIT', `Expected 1..${max}`); return value; }
type Row = Record<string, unknown>;
export class DurableStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private faultCode: string | null = null;
  private lastFailureAt: number | null = null;
  private readonly now: () => number;
  private readonly maxRuns: number;
  constructor(path: string, options: { clock?: () => number; maxRuns?: number } = {}) {
    this.maxRuns = bounded(options.maxRuns ?? 10000, 1000000);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.now = options.clock ?? Date.now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.transaction(() => {
        const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
        if (version > 1) throw new DurableError('SCHEMA_VERSION', 'Database requires a newer runtime');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,principal TEXT NOT NULL,slot TEXT NOT NULL,operation TEXT NOT NULL,idem_key TEXT NOT NULL,intent TEXT NOT NULL,context TEXT NOT NULL,capability TEXT NOT NULL,cap_version TEXT NOT NULL,binding_version TEXT NOT NULL,input TEXT NOT NULL,input_digest TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,result TEXT,error TEXT,UNIQUE(principal,slot,operation,idem_key));
      CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id),seq INTEGER NOT NULL,type TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL REFERENCES runs(id),status TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL,reason TEXT NOT NULL,actor TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL REFERENCES runs(id),dispatch_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),outcome TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
      CREATE TRIGGER IF NOT EXISTS immutable_run BEFORE UPDATE OF principal,slot,operation,idem_key,intent,context,capability,cap_version,binding_version,input,input_digest,created ON runs BEGIN SELECT RAISE(ABORT,'immutable run identity'); END;
      PRAGMA user_version=1;
        `);
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  /** Read-only probe. The latch preserves a past write failure even if SELECT currently succeeds. */
  health(): StoreHealth {
    if (!this.closed) { try { this.db.prepare('SELECT COUNT(*) FROM sqlite_schema').get(); } catch (error) { this.recordFailure(error); } }
    return { available: !this.closed && this.faultCode === null, state: this.closed ? 'CLOSED' : this.faultCode ? 'FAULTED' : 'READY', faultCode: this.faultCode, lastFailureAt: this.lastFailureAt, schemaVersion: 1, payloadProtection: 'plaintext-local' };
  }
  private recordFailure(error: unknown): void {
    if (error instanceof DurableError) return;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'STORAGE_FAILURE';
    this.faultCode = /^ERR_[A-Z_]+$/.test(code) ? code : 'STORAGE_FAILURE'; this.lastFailureAt = this.now();
  }
  private transaction<T>(body: () => T): T {
    let begun = false;
    try { this.db.exec('BEGIN IMMEDIATE'); begun = true; const result = body(); this.db.exec('COMMIT'); begun = false; return result; }
    catch (error) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch (rollbackError) { this.recordFailure(rollbackError); } }
      this.recordFailure(error); throw error;
    }
  }
  private event(id: string, type: string, data: Json = null): void { this.db.prepare('INSERT INTO events VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE run_id=?),?,?,?)').run(id, id, type, this.now(), encode(data)); }
  private change(id: string, version: number, state: RunState, error: string | null = null, result: Json | null = null): void {
    const from = this.row(id).state as RunState;
    const permitted: Partial<Record<RunState, RunState[]>> = {
      QUEUED: ['WAITING_APPROVAL', 'RUNNING', 'DENIED', 'FAILED', 'EXPIRED', 'CANCELLED'],
      WAITING_APPROVAL: ['QUEUED', 'DENIED', 'EXPIRED', 'CANCELLED'],
      RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED', 'UNKNOWN'],
      CANCEL_REQUESTED: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
      UNKNOWN: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    };
    if (!permitted[from]?.includes(state)) throw new DurableError('STATE_CONFLICT', `Invalid transition from ${from} to ${state}`);
    const changed = this.db.prepare('UPDATE runs SET state=?,version=version+1,updated=?,error=?,result=? WHERE id=? AND version=?').run(state, this.now(), error, result === null ? null : encode(result), id, version);
    if (!changed.changes) throw new DurableError('STATE_CONFLICT', 'Run changed concurrently');
    this.event(id, state);
  }
  private row(id: string): Row { const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id); if (!row) throw new DurableError('NOT_FOUND', 'Execution not found'); return row; }
  internal(id: string): Run {
    const r = this.row(id);
    return { executionId: String(r.id), context: Object.freeze(JSON.parse(String(r.context))), capability: String(r.capability), capabilityVersion: String(r.cap_version), bindingVersion: String(r.binding_version), inputDigest: String(r.input_digest), intentDigest: String(r.intent), state: r.state as RunState, stateVersion: Number(r.version), createdAt: Number(r.created), updatedAt: Number(r.updated), result: r.result === null ? null : JSON.parse(String(r.result)), error: r.error === null ? null : String(r.error), approval: this.approvalFor(id) };
  }
  status(owner: Owner, id: string): Run { const run = this.internal(id); if (run.context.principal !== owner.principal || run.context.slotId !== owner.slotId) throw new DurableError('NOT_FOUND', 'Execution not found'); return run; }
  input(id: string): Json { return JSON.parse(String(this.row(id).input)); }
  private cancellationRecorded(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE run_id=? AND type IN ('CANCEL_REQUESTED','CANCELLED') LIMIT 1").get(id));
  }
  private reconciliationSnapshotInternal(owner: Owner, id: string): ReconciliationSnapshot {
    const run = this.status(owner, id);
    const attempt = this.db.prepare('SELECT * FROM attempts WHERE run_id=?').get(id);
    if (!attempt || !['DISPATCHING', 'UNCONFIRMED'].includes(String(attempt.status))) throw new DurableError('RECONCILIATION_NOT_SUPPORTED', 'No original unconfirmed attempt is available');
    return { run, input: this.input(id), attempt: { id: String(attempt.id), dispatchKey: String(attempt.dispatch_key), status: attempt.status as 'DISPATCHING' | 'UNCONFIRMED' }, cancellationRequested: this.cancellationRecorded(id) };
  }
  /** Consistent trusted snapshot; callers still need transaction-time CAS when committing evidence. */
  reconciliationSnapshot(owner: Owner, id: string): ReconciliationSnapshot {
    return this.transaction(() => this.reconciliationSnapshotInternal(owner, id));
  }
  reconcile(request: { proof: VerifiedReconciliationProof; actor: string }): Run {
    const plan = readReconciliationProof(request.proof);
    if (!request.actor.trim() || request.actor.length > 256) throw new DurableError('INVALID_DECISION', 'Local operator identity is required');
    const serialized = encode(plan.result);
    const hash = digest({ outcome: plan.outcome, payload: plan.result });
    if (!['SUCCEEDED', 'FAILED'].includes(plan.outcome) || hash !== plan.evidenceDigest) throw new DurableError('RECONCILIATION_PROOF_INVALID', 'Receipt outcome is inconsistent');
    return this.transaction(() => {
      const run = this.status(plan.owner, plan.executionId);
      if (run.capability !== 'process_run' || run.inputDigest !== plan.inputDigest || run.intentDigest !== plan.intentDigest || run.bindingVersion !== plan.bindingVersion || plan.processDispatchKey !== `${run.executionId}:attempt1`) throw new DurableError('RECONCILIATION_PROOF_INVALID', 'Receipt does not match the original intent');
      if (this.cancellationRecorded(run.executionId)) throw new DurableError('RECONCILIATION_CANCELLED', 'Cancellation intent requires separate reconciliation');
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE id=? AND run_id=?').get(plan.coreAttemptId, run.executionId);
      if (!attempt || attempt.dispatch_key !== plan.coreDispatchKey) throw new DurableError('RECEIPT_INVALID', 'Original Core attempt does not match');
      const previous = this.db.prepare('SELECT * FROM receipts WHERE attempt_id=?').get(plan.coreAttemptId);
      if (previous) {
        const reconciled = this.db.prepare("SELECT 1 FROM events WHERE run_id=? AND type='RECONCILED' LIMIT 1").get(run.executionId);
        if (reconciled && previous.digest === hash && run.state === plan.outcome && run.stateVersion === plan.expectedStateVersion + 1) return run;
        throw new DurableError('RECEIPT_CONFLICT', 'A different receipt already exists');
      }
      if (run.state !== 'UNKNOWN' || run.stateVersion !== plan.expectedStateVersion || !['DISPATCHING', 'UNCONFIRMED'].includes(String(attempt.status))) throw new DurableError('STATE_CONFLICT', 'Unknown Run or attempt changed concurrently');
      const snapshot = this.reconciliationSnapshotInternal(plan.owner, run.executionId);
      const currentSnapshotDigest = digest({ run: JSON.parse(JSON.stringify(snapshot.run)), attempt: { ...snapshot.attempt }, cancellationRequested: snapshot.cancellationRequested });
      const intent = digest({ context: { ...run.context }, capability: run.capability, capabilityVersion: run.capabilityVersion, bindingVersion: run.bindingVersion, input: snapshot.input });
      if (currentSnapshotDigest !== plan.expectedSnapshotDigest || digest(snapshot.input) !== run.inputDigest || intent !== run.intentDigest) throw new DurableError('STATE_CONFLICT', 'Original reconciliation snapshot changed');
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(plan.coreAttemptId, plan.outcome, serialized, hash, this.now());
      this.db.prepare("UPDATE attempts SET status='COMPLETED' WHERE id=?").run(plan.coreAttemptId);
      this.db.prepare("UPDATE outbox SET status='DELIVERED' WHERE id=? AND kind='DISPATCH'").run(plan.coreAttemptId);
      this.change(run.executionId, plan.expectedStateVersion, plan.outcome, plan.outcome === 'FAILED' ? 'EXECUTION_FAILED' : null, plan.result);
      this.event(run.executionId, 'RECONCILED', { actor: request.actor, source: 'trusted-process-receipt', priorResult: run.result,
        processDispatchKey: plan.processDispatchKey, evidenceDigest: hash, expectedStateVersion: plan.expectedStateVersion });
      return this.internal(run.executionId);
    });
  }
  create(context: ExecutionContext, capability: CapabilityIdentity, input: Json, key: string): Run {
    for (const value of [...Object.values(context), ...Object.values(capability), key]) if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new DurableError('INVALID_INPUT', 'Identity values must be nonempty bounded strings');
    const payload = encode(input), inputHash = digest(input), intent = digest({ context: { ...context }, ...capability, input });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT id,intent FROM runs WHERE principal=? AND slot=? AND operation=? AND idem_key=?').get(context.principal, context.slotId, 'execution_submit', key);
      if (previous) { if (previous.intent !== intent) throw new DurableError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different intent'); return this.internal(String(previous.id)); }
      if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM runs').get()!.count) >= this.maxRuns) throw new DurableError('STORE_CAPACITY', 'Run capacity reached; retention requires explicit maintenance');
      const id = randomUUID(), at = this.now();
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, context.principal, context.slotId, 'execution_submit', key, intent, encode({ ...context }), capability.capability, capability.capabilityVersion, capability.bindingVersion, payload, inputHash, 'QUEUED', 1, at, at, null, null);
      this.event(id, 'CREATED'); return this.internal(id);
    });
  }
  events(owner: Owner, id: string, after = 0, limit = 100): RunEvent[] {
    this.status(owner, id); bounded(limit, 500);
    if (!Number.isSafeInteger(after) || after < 0) throw new DurableError('INVALID_CURSOR', 'Invalid event cursor');
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit).map(r => ({ executionId: id, sequence: Number(r.seq), type: String(r.type), at: Number(r.at), data: JSON.parse(String(r.data)) }));
  }
  queued(limit = 100, capabilities?: readonly string[]): Run[] {
    bounded(limit, 1000);
    if (capabilities?.length === 0) return [];
    if (capabilities) bounded(capabilities.length, 512);
    const filter = capabilities ? ` AND capability IN (${capabilities.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT id FROM runs WHERE state='QUEUED'${filter} ORDER BY created,id LIMIT ?`).all(...(capabilities ?? []), limit).map(r => this.internal(String(r.id)));
  }
  private approvalFor(id: string): Approval | null { const r = this.db.prepare('SELECT * FROM approvals WHERE run_id=?').get(id); return r ? this.approvalRow(r) : null; }
  private approvalRow(r: Row): Approval { return { approvalId: String(r.id), executionId: String(r.run_id), status: r.status as Approval['status'], decisionVersion: Number(r.version), expiresAt: Number(r.expires), reason: String(r.reason) }; }
  pending(slotId: string, limit = 100): Approval[] { bounded(limit, 500); this.expire(); return this.db.prepare("SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.slot=? AND a.status='PENDING' ORDER BY a.expires LIMIT ?").all(slotId, limit).map(r => this.approvalRow(r)); }
  awaitApproval(id: string, version: number, reason: string, expires: number): void {
    if (!Number.isFinite(expires) || expires <= this.now() || expires > this.now() + 24 * 60 * 60 * 1000) throw new DurableError('INVALID_EXPIRY', 'Approval expiry must be within 24 hours');
    this.transaction(() => { this.db.prepare("INSERT INTO approvals VALUES(?,?,'PENDING',1,?,?,NULL)").run(randomUUID(), id, expires, reason.slice(0, 2000)); this.change(id, version, 'WAITING_APPROVAL'); });
  }
  decide(request: OperatorDecision): Run {
    this.expire();
    if (!request.actor.trim() || request.actor.length > 256 || !['APPROVE', 'DENY'].includes(request.decision)) throw new DurableError('INVALID_DECISION', 'Invalid operator decision');
    return this.transaction(() => {
      const a = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(request.approvalId);
      if (!a) throw new DurableError('NOT_FOUND', 'Approval not found');
      const r = this.internal(String(a.run_id));
      if (a.status !== 'PENDING' || Number(a.version) !== request.expectedDecisionVersion || r.state !== 'WAITING_APPROVAL') throw new DurableError('APPROVAL_CONFLICT', 'Approval is no longer pending at this version');
      const allow = request.decision === 'APPROVE';
      this.db.prepare('UPDATE approvals SET status=?,version=version+1,actor=? WHERE id=?').run(allow ? 'APPROVED' : 'DENIED', request.actor, request.approvalId);
      this.change(r.executionId, r.stateVersion, allow ? 'QUEUED' : 'DENIED');
      if (allow) this.db.prepare("INSERT INTO outbox VALUES(?,?,'RESUME','PENDING')").run(randomUUID(), r.executionId);
      this.event(r.executionId, 'APPROVAL_DECIDED', { actor: request.actor, decision: request.decision });
      return this.internal(r.executionId);
    });
  }
  expire(): void { this.transaction(() => {
    const rows = this.db.prepare("SELECT a.id,a.run_id FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.status IN ('PENDING','APPROVED') AND a.expires<=? AND r.state IN ('WAITING_APPROVAL','QUEUED')").all(this.now());
    for (const a of rows) { const r = this.internal(String(a.run_id)); this.db.prepare("UPDATE approvals SET status='EXPIRED',version=version+1 WHERE id=?").run(String(a.id)); this.change(r.executionId, r.stateVersion, 'EXPIRED'); this.db.prepare("UPDATE outbox SET status='CANCELLED' WHERE run_id=? AND status='PENDING'").run(r.executionId); }
  }); }
  deny(id: string, version: number, reason: string): void { this.transaction(() => this.change(id, version, 'DENIED', reason.slice(0, 2000))); }
  failBeforeDispatch(id: string, version: number, reason: string): void { this.transaction(() => this.change(id, version, 'FAILED', reason)); }
  dispatch(id: string, version: number): string {
    return this.transaction(() => {
      const r = this.internal(id);
      if (r.state !== 'QUEUED' || r.stateVersion !== version) throw new DurableError('STATE_CONFLICT', 'Run is not dispatchable');
      if (r.approval && (r.approval.status !== 'APPROVED' || r.approval.expiresAt <= this.now())) throw new DurableError('APPROVAL_CONFLICT', 'Approval is not valid');
      const attempt = randomUUID();
      this.db.prepare("INSERT INTO attempts VALUES(?,?,?,'DISPATCHING')").run(attempt, id, attempt);
      this.db.prepare("UPDATE outbox SET status='DELIVERED' WHERE run_id=? AND kind='RESUME'").run(id);
      this.db.prepare("INSERT INTO outbox VALUES(?,?,'DISPATCH','DISPATCHING')").run(attempt, id);
      this.change(id, version, 'RUNNING'); return attempt;
    });
  }
  finish(id: string, attempt: string, outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED', payload: Json): void {
    const serialized = encode(payload);
    this.transaction(() => {
      const a = this.db.prepare('SELECT * FROM attempts WHERE id=? AND run_id=?').get(attempt, id);
      if (!a) throw new DurableError('RECEIPT_INVALID', 'Receipt does not match an attempt');
      const previous = this.db.prepare('SELECT * FROM receipts WHERE attempt_id=?').get(attempt), hash = digest({ outcome, payload });
      if (previous) { if (previous.digest !== hash) throw new DurableError('RECEIPT_CONFLICT', 'Receipt content changed'); return; }
      const r = this.internal(id);
      if (!['RUNNING', 'CANCEL_REQUESTED', 'UNKNOWN'].includes(r.state)) throw new DurableError('STATE_CONFLICT', 'Execution cannot accept receipt');
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(attempt, outcome, serialized, hash, this.now());
      this.db.prepare("UPDATE attempts SET status='COMPLETED' WHERE id=?").run(attempt);
      this.db.prepare("UPDATE outbox SET status='DELIVERED' WHERE id=? AND kind='DISPATCH'").run(attempt);
      this.change(id, r.stateVersion, outcome, outcome === 'FAILED' ? 'EXECUTION_FAILED' : null, payload);
    });
  }
  unconfirmed(id: string, attempt: string, evidence: Json): void {
    encode(evidence);
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM attempts WHERE id=? AND run_id=?').get(attempt, id)) throw new DurableError('RECEIPT_INVALID', 'Unknown executor attempt');
      const run = this.internal(id);
      if (!['RUNNING', 'CANCEL_REQUESTED'].includes(run.state)) throw new DurableError('STATE_CONFLICT', 'Execution is not awaiting an outcome');
      this.db.prepare("UPDATE attempts SET status='UNCONFIRMED' WHERE id=?").run(attempt);
      this.change(id, run.stateVersion, 'UNKNOWN', 'EXECUTOR_OUTCOME_UNCONFIRMED', evidence);
    });
  }
  cancel(owner: Owner, id: string): Run { return this.transaction(() => {
    const r = this.status(owner, id);
    if (['QUEUED', 'WAITING_APPROVAL'].includes(r.state)) {
      this.db.prepare("UPDATE approvals SET status='CANCELLED',version=version+1 WHERE run_id=? AND status IN ('PENDING','APPROVED')").run(id);
      this.db.prepare("UPDATE outbox SET status='CANCELLED' WHERE run_id=? AND status='PENDING'").run(id);
      this.change(id, r.stateVersion, 'CANCELLED');
    } else if (r.state === 'RUNNING') this.change(id, r.stateVersion, 'CANCEL_REQUESTED');
    else if (r.state === 'UNKNOWN' && !this.cancellationRecorded(id)) {
      const changed = this.db.prepare("UPDATE runs SET version=version+1,updated=? WHERE id=? AND version=? AND state='UNKNOWN'").run(this.now(), id, r.stateVersion);
      if (!changed.changes) throw new DurableError('STATE_CONFLICT', 'Run changed concurrently');
      this.event(id, 'CANCEL_REQUESTED', { stateUnchanged: 'UNKNOWN', terminationConfirmed: false });
    }
    return this.internal(id);
  }); }
  /** Only call once the previous Core owner is stopped. In-process handlers cannot be reattached. */
  recover(): void { this.expire(); this.transaction(() => {
    for (const r of this.db.prepare("SELECT id,version FROM runs WHERE state IN ('RUNNING','CANCEL_REQUESTED')").all()) this.change(String(r.id), Number(r.version), 'UNKNOWN', 'Executor completion is unconfirmed; automatic replay is prohibited');
  }); }
}
