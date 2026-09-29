import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDurableKernel, DurableError, DurableStore, ExecutionDetached, ExecutionFailure, UnconfirmedOutcome, type ExecutionContext, type Run, type RunState } from '../v3/durable/index.js';

async function crashChild(path: string): Promise<void> {
  const runtime = createDurableKernel({ store: new DurableStore(join(path, 'killed.db')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  runtime.kernel.register({ capability: 'external-effect', capabilityVersion: '1', bindingVersion: '1', execute: async ({ run }) => {
    await appendFile(join(path, 'external-effect.txt'), 'effect\n');
    process.send?.({ executionId: run.executionId });
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
    return null;
  } });
  runtime.kernel.submit({ hostId: 'host', principal: 'alice', slotId: 'A', workspaceId: 'workspace', workspaceRoot: path, authorizationRevision: '1' }, { capability: 'external-effect', input: null, idempotencyKey: 'killed' });
}

async function suite(): Promise<void> {
const dir = await mkdtemp(join(tmpdir(), 'p05-v3-durable-'));
const context: ExecutionContext = { hostId: 'host', slotId: 'A', principal: 'alice', workspaceId: 'workspace', workspaceRoot: dir, authorizationRevision: '1' };
let now = 10000, executions = 0, allowed = true;
const clock = () => now;
const options = () => ({ store: new DurableStore(join(dir, 'state.db'), { clock }), clock, authorize: () => ({ decision: 'CONFIRM' as const, reason: 'write approval', expiresAt: now + 1000 }), revalidate: () => allowed });
let runtime = createDurableKernel(options());
const cap = { capability: 'write', capabilityVersion: '1', bindingVersion: '1', execute: async () => { executions++; return { saved: true }; } };
const settle = async (id: string, state: RunState): Promise<Run> => { for (let i = 0; i < 200; i++) { const r = runtime.kernel.status(context, id); if (r.state === state) return r; await sleep(5); } throw new Error(`Execution did not reach ${state}`); };
try {
  runtime.kernel.register(cap);
  const input = { z: 2, a: 1 };
  const submitted = runtime.kernel.submit(context, { capability: 'write', input, idempotencyKey: 'one' });
  context.workspaceRoot = 'changed-after-submit'; input.a = 99;
  const waiting = await settle(submitted.executionId, 'WAITING_APPROVAL');
  assert.equal(waiting.context.workspaceRoot, dir); context.workspaceRoot = dir;
  assert.equal(executions, 0);
  const duplicate = runtime.kernel.submit(context, { capability: 'write', input: { a: 1, z: 2 }, idempotencyKey: 'one' });
  assert.equal(duplicate.executionId, submitted.executionId);
  assert.throws(() => runtime.kernel.submit(context, { capability: 'write', input: { a: 2, z: 2 }, idempotencyKey: 'one' }), (e: unknown) => e instanceof DurableError && e.code === 'IDEMPOTENCY_CONFLICT');
  for (const owner of [{ principal: 'bob', slotId: 'A' }, { principal: 'alice', slotId: 'B' }]) {
    assert.throws(() => runtime.kernel.status(owner, submitted.executionId), /not found/);
    assert.throws(() => runtime.kernel.events(owner, submitted.executionId), /not found/);
    assert.throws(() => runtime.kernel.cancel(owner, submitted.executionId), /not found/);
    await assert.rejects(runtime.kernel.wait(owner, submitted.executionId, waiting.stateVersion, 0), /not found/);
  }
  const timed = await runtime.kernel.wait(context, submitted.executionId, waiting.stateVersion, 20);
  assert.equal(timed.waitOutcome, 'timeout'); assert.equal(timed.run.stateVersion, waiting.stateVersion);
  await runtime.kernel.close();
  runtime = createDurableKernel(options()); runtime.kernel.register(cap);
  const recovered = runtime.kernel.status(context, submitted.executionId);
  assert.equal(recovered.state, 'WAITING_APPROVAL');
  const approval = recovered.approval!;
  const decision = { approvalId: approval.approvalId, expectedDecisionVersion: approval.decisionVersion, decision: 'APPROVE' as const, actor: 'local-operator' };
  runtime.operator.decide(decision);
  assert.throws(() => runtime.operator.decide(decision), /no longer pending/);
  await settle(submitted.executionId, 'SUCCEEDED'); assert.equal(executions, 1);
  const events = runtime.kernel.events(context, submitted.executionId);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.equal(runtime.kernel.events(context, submitted.executionId, 2, 2).length, 2);
  assert.throws(() => runtime.kernel.events(context, submitted.executionId, 0, 501), /Expected/);
  const deniedRun = runtime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'denied' });
  const deniedApproval = (await settle(deniedRun.executionId, 'WAITING_APPROVAL')).approval!;
  runtime.operator.decide({ approvalId: deniedApproval.approvalId, expectedDecisionVersion: 1, actor: 'operator', decision: 'DENY' });
  await settle(deniedRun.executionId, 'DENIED');
  const cancelled = runtime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'cancel' });
  const cancelApproval = (await settle(cancelled.executionId, 'WAITING_APPROVAL')).approval!;
  runtime.kernel.cancel(context, cancelled.executionId);
  assert.throws(() => runtime.operator.decide({ approvalId: cancelApproval.approvalId, expectedDecisionVersion: 1, actor: 'operator', decision: 'APPROVE' }), /no longer pending/);
  const expiry = runtime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'expiry' });
  await settle(expiry.executionId, 'WAITING_APPROVAL'); now += 1001;
  assert.equal(runtime.kernel.status(context, expiry.executionId).state, 'EXPIRED');
  const revoked = runtime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'revoked' });
  const revApproval = (await settle(revoked.executionId, 'WAITING_APPROVAL')).approval!;
  allowed = false;
  runtime.operator.decide({ approvalId: revApproval.approvalId, expectedDecisionVersion: 1, actor: 'operator', decision: 'APPROVE' });
  await settle(revoked.executionId, 'DENIED'); assert.equal(executions, 1); allowed = true;
  await runtime.kernel.close();

  // Simulate a process crash at the durable dispatch boundary: no handler replay on reopen.
  const store = new DurableStore(join(dir, 'state.db'), { clock });
  const crash = store.create(context, { capability: 'write', capabilityVersion: '1', bindingVersion: '1' }, null, 'crashed');
  const attempt = store.dispatch(crash.executionId, crash.stateVersion); store.close();
  runtime = createDurableKernel(options()); runtime.kernel.register(cap);
  assert.equal(runtime.kernel.status(context, crash.executionId).state, 'UNKNOWN');
  await sleep(20); assert.equal(executions, 1);
  await runtime.kernel.close();
  const receipts = new DurableStore(join(dir, 'state.db'), { clock });
  receipts.finish(crash.executionId, attempt, 'SUCCEEDED', { receipt: true });
  receipts.finish(crash.executionId, attempt, 'SUCCEEDED', { receipt: true });
  assert.throws(() => receipts.finish(crash.executionId, attempt, 'SUCCEEDED', { receipt: false }), /Receipt content changed/);
  assert.equal(receipts.status(context, crash.executionId).state, 'SUCCEEDED');
  // Approved pre-dispatch work survives restart, preserving the original execution ID.
  const queued = receipts.create(context, { capability: 'write', capabilityVersion: '1', bindingVersion: '1' }, null, 'approved-restart');
  receipts.awaitApproval(queued.executionId, queued.stateVersion, 'approve', now + 1000);
  const qa = receipts.internal(queued.executionId).approval!;
  receipts.decide({ approvalId: qa.approvalId, expectedDecisionVersion: 1, decision: 'APPROVE', actor: 'operator' }); receipts.close();
  runtime = createDurableKernel(options()); runtime.kernel.register(cap);
  await settle(queued.executionId, 'SUCCEEDED'); assert.equal(executions, 2);
  await runtime.kernel.close();
  const mismatchStore = new DurableStore(join(dir, 'state.db'), { clock });
  const mismatch = mismatchStore.create(context, { capability: 'write', capabilityVersion: '1', bindingVersion: 'obsolete' }, null, 'mismatch');
  mismatchStore.close();
  runtime = createDurableKernel(options()); runtime.kernel.register(cap);
  assert.equal((await settle(mismatch.executionId, 'FAILED')).error, 'PINNED_BINDING_UNAVAILABLE');
  assert.equal(executions, 2);
  await runtime.kernel.close();

  // Pending approval freezes context/input and never retargets to a replacement binding.
  const pendingBindingPath = join(dir, 'pending-binding.db');
  const pendingContext: ExecutionContext = { ...context };
  const pendingInput = { frozen: 'original' };
  let oldBindingExecutions = 0, newBindingExecutions = 0;
  let bindingRuntime = createDurableKernel({ store: new DurableStore(pendingBindingPath, { clock }),
    authorize: () => ({ decision: 'CONFIRM' as const, reason: 'binding approval', expiresAt: now + 1000 }), revalidate: () => true });
  bindingRuntime.kernel.register({ capability: 'binding-write', capabilityVersion: '1', bindingVersion: '1', execute: async () => { oldBindingExecutions++; return null; } });
  const pendingBinding = bindingRuntime.kernel.submit(pendingContext, { capability: 'binding-write', input: pendingInput, idempotencyKey: 'binding-pending' });
  pendingContext.workspaceRoot = 'retargeted-after-submit'; pendingInput.frozen = 'mutated-after-submit';
  let bindingWaiting = bindingRuntime.kernel.status(context, pendingBinding.executionId);
  for (let i = 0; bindingWaiting.state !== 'WAITING_APPROVAL' && i < 200; i++) { await sleep(5); bindingWaiting = bindingRuntime.kernel.status(context, pendingBinding.executionId); }
  assert.equal(bindingWaiting.state, 'WAITING_APPROVAL');
  assert.equal(bindingWaiting.context.workspaceRoot, dir);
  const bindingApproval = bindingWaiting.approval!;
  await bindingRuntime.kernel.close();
  const frozenIntent = new DurableStore(pendingBindingPath, { clock });
  assert.deepEqual(frozenIntent.input(pendingBinding.executionId), { frozen: 'original' });
  frozenIntent.close();
  bindingRuntime = createDurableKernel({ store: new DurableStore(pendingBindingPath, { clock }), authorize: () => ({ decision: 'ALLOW' as const }), revalidate: () => true });
  bindingRuntime.kernel.register({ capability: 'binding-write', capabilityVersion: '1', bindingVersion: '2', execute: async () => { newBindingExecutions++; return null; } });
  bindingRuntime.operator.decide({ approvalId: bindingApproval.approvalId, expectedDecisionVersion: bindingApproval.decisionVersion, decision: 'APPROVE', actor: 'operator' });
  let bindingFailed = bindingRuntime.kernel.status(context, pendingBinding.executionId);
  for (let i = 0; bindingFailed.state !== 'FAILED' && i < 200; i++) { await sleep(5); bindingFailed = bindingRuntime.kernel.status(context, pendingBinding.executionId); }
  assert.equal(bindingFailed.state, 'FAILED');
  assert.equal(bindingFailed.error, 'PINNED_BINDING_UNAVAILABLE');
  assert.equal(oldBindingExecutions, 0); assert.equal(newBindingExecutions, 0);
  await bindingRuntime.kernel.close();

  // Terminal truth is carried by the Run/receipt, not by retention of audit events.
  const auditPath = join(dir, 'audit-independent.db');
  const auditStore = new DurableStore(auditPath, { clock });
  const auditIdentity = { capability: 'write', capabilityVersion: '1', bindingVersion: '1' }; const auditRun = auditStore.create(context, auditIdentity, { audited: true }, 'audit-independent');
  const auditAttempt = auditStore.dispatch(auditRun.executionId, auditRun.stateVersion);
  auditStore.finish(auditRun.executionId, auditAttempt, 'SUCCEEDED', { truth: 'receipt' });
  assert.ok(auditStore.events(context, auditRun.executionId).length > 0);
  auditStore.close();
  const auditDb = new DatabaseSync(auditPath);
  auditDb.exec("DELETE FROM events WHERE run_id='" + auditRun.executionId.replace(/'/g, "''") + "'");
  assert.equal((auditDb.prepare('SELECT COUNT(*) AS n FROM receipts WHERE attempt_id=?').get(auditAttempt) as { n: number }).n, 1);
  auditDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  auditDb.close();
  const withoutAudit = new DurableStore(auditPath, { clock });
  assert.equal(withoutAudit.status(context, auditRun.executionId).state, 'SUCCEEDED');
  assert.deepEqual(withoutAudit.status(context, auditRun.executionId).result, { truth: 'receipt' });
  assert.equal(withoutAudit.events(context, auditRun.executionId).length, 0);
  withoutAudit.close();
  await sleep(250);

  // Admission limits do not break safe retries and terminal state cannot be overwritten.
  const bounded = new DurableStore(join(dir, 'bounded.db'), { maxRuns: 1 });
  const identity = { capability: 'write', capabilityVersion: '1', bindingVersion: '1' };
  const single = bounded.create(context, identity, null, 'single');
  assert.equal(bounded.create(context, identity, null, 'single').executionId, single.executionId);
  assert.throws(() => bounded.create(context, identity, null, 'second'), /capacity/);
  bounded.cancel(context, single.executionId);
  assert.throws(() => bounded.deny(single.executionId, 2, 'late denial'), /Invalid transition/);
  assert.equal(bounded.events(context, single.executionId).length, 2); bounded.close();

  // A handler ignoring abort cannot make bounded close hang or claim cancellation succeeded.
  let release: ((value: null) => void) | undefined;
  const slow = createDurableKernel({ store: new DurableStore(join(dir, 'slow.db')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  slow.kernel.register({ ...cap, capability: 'slow', execute: () => new Promise<null>(resolve => { release = resolve; }) });
  const slowRun = slow.kernel.submit(context, { capability: 'slow', input: null, idempotencyKey: 'slow' });
  for (let i = 0; !release && i < 200; i++) await sleep(5);
  assert.ok(release);
  assert.equal(slow.kernel.cancel(context, slowRun.executionId).state, 'CANCEL_REQUESTED');
  await Promise.all([slow.kernel.close(10), slow.kernel.close(10)]);
  const slowStore = new DurableStore(join(dir, 'slow.db'));
  assert.equal(slowStore.status(context, slowRun.executionId).state, 'UNKNOWN');
  release(null); await sleep(10);
  assert.equal(slowStore.status(context, slowRun.executionId).state, 'UNKNOWN'); slowStore.close();

  // Core shutdown detaches observation; only an explicit user cancellation authorizes executor cancellation.
  const abortPath = join(dir, 'abort-reasons.db');
  const abortRuntime = createDurableKernel({ store: new DurableStore(abortPath), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  const observedSignals = new Map<string, AbortSignal>();
  let externalCancellations = 0;
  abortRuntime.kernel.register({ ...cap, capability: 'observed-external', execute: ({ run, signal }) => new Promise<null>((_resolve, reject) => {
    observedSignals.set(run.executionId, signal);
    signal.addEventListener('abort', () => {
      if (signal.reason instanceof ExecutionDetached) reject(new UnconfirmedOutcome('PROCESS_CORE_DETACHED'));
      else { externalCancellations++; reject(new UnconfirmedOutcome('PROCESS_CANCEL_UNCONFIRMED')); }
    }, { once: true });
  }) });
  const userCancelled = abortRuntime.kernel.submit(context, { capability: 'observed-external', input: null, idempotencyKey: 'user-cancel' });
  const coreDetached = abortRuntime.kernel.submit(context, { capability: 'observed-external', input: null, idempotencyKey: 'core-detach' });
  for (let i = 0; observedSignals.size !== 2 && i < 200; i++) await sleep(5);
  assert.equal(observedSignals.size, 2);
  assert.equal(abortRuntime.kernel.cancel(context, userCancelled.executionId).state, 'CANCEL_REQUESTED');
  assert.equal(observedSignals.get(userCancelled.executionId)!.reason instanceof ExecutionDetached, false);
  await abortRuntime.kernel.close(100);
  assert.equal(externalCancellations, 1);
  const detachReason: unknown = observedSignals.get(coreDetached.executionId)!.reason;
  assert.ok(detachReason instanceof ExecutionDetached); assert.equal(detachReason.code, 'CORE_DETACHED');
  assert.equal(observedSignals.get(userCancelled.executionId)!.reason instanceof ExecutionDetached, false);
  const abortReopened = new DurableStore(abortPath);
  assert.equal(abortReopened.status(context, userCancelled.executionId).state, 'UNKNOWN');
  assert.equal(abortReopened.status(context, coreDetached.executionId).state, 'UNKNOWN');
  assert.deepEqual(abortReopened.status(context, coreDetached.executionId).result, { code: 'PROCESS_CORE_DETACHED', evidence: null, sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false });
  assert.equal(abortReopened.events(context, coreDetached.executionId).some(event => event.type === 'CANCEL_REQUESTED'), false);
  abortReopened.close();

  // Real process death after an external effect, before durable completion receipt.
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, P05_V3_DURABLE_CRASH_TEST: dir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exit = once(child, 'exit');
  const timeoutController = new AbortController();
  let killedId: string;
  try {
    const message = await Promise.race([
      once(child, 'message').then(([message]) => message as { executionId: string }),
      exit.then(() => { throw new Error('Crash-test child exited before effect'); }),
      sleep(10000, undefined, { signal: timeoutController.signal }).then(() => { throw new Error('Crash-test child timed out'); }),
    ]);
    killedId = message.executionId;
  } finally { timeoutController.abort(); child.kill('SIGKILL'); await exit; }
  let replays = 0;
  const restarted = createDurableKernel({ store: new DurableStore(join(dir, 'killed.db')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  restarted.kernel.register({ capability: 'external-effect', capabilityVersion: '1', bindingVersion: '1', execute: async () => { replays++; return null; } });
  assert.equal(restarted.kernel.status(context, killedId!).state, 'UNKNOWN');
  await sleep(25); assert.equal(replays, 0);
  assert.equal(await readFile(join(dir, 'external-effect.txt'), 'utf8'), 'effect\n');
  await restarted.kernel.close();

  // SQLite busy at BEGIN does not leave a partial Run/event and latches unhealthy scheduling.
  const busyPath = join(dir, 'busy.db');
  const busyStore = new DurableStore(busyPath);
  const busyRuntime = createDurableKernel({ store: busyStore, authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  busyRuntime.kernel.register(cap);
  const lock = new DatabaseSync(busyPath); lock.exec('BEGIN IMMEDIATE');
  assert.throws(() => busyRuntime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'locked' }), /locked|busy/);
  assert.equal(busyRuntime.kernel.health().executionAvailable, false);
  assert.equal(busyRuntime.kernel.health().scheduler, 'STOPPED');
  assert.equal(busyRuntime.kernel.health().storage.state, 'FAULTED');
  lock.exec('ROLLBACK'); lock.close();
  assert.equal(busyStore.queued().length, 0);
  assert.equal(busyRuntime.kernel.health().executionAvailable, false);
  await busyRuntime.kernel.close();
  assert.equal(busyRuntime.kernel.health().scheduler, 'CLOSED');
  const healthyAgain = createDurableKernel({ store: new DurableStore(busyPath), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  assert.equal(healthyAgain.kernel.health().executionAvailable, true); await healthyAgain.kernel.close();

  // Approving is not reserving an unlimited lifetime: expiry during async revalidation blocks dispatch.
  const expiryStore = new DurableStore(join(dir, 'approved-expiry.db'), { clock });
  const approvalRun = expiryStore.create(context, identity, null, 'approved-expiry');
  expiryStore.awaitApproval(approvalRun.executionId, 1, 'expiry', now + 100);
  const expApproval = expiryStore.internal(approvalRun.executionId).approval!;
  expiryStore.decide({ approvalId: expApproval.approvalId, expectedDecisionVersion: 1, decision: 'APPROVE', actor: 'operator' });
  let releaseValidation: ((allowed: boolean) => void) | undefined;
  const expiryRuntime = createDurableKernel({ store: expiryStore, authorize: () => ({ decision: 'ALLOW' }), revalidate: () => new Promise<boolean>(resolve => { releaseValidation = resolve; }) });
  expiryRuntime.kernel.register(cap);
  for (let i = 0; !releaseValidation && i < 200; i++) await sleep(5);
  assert.ok(releaseValidation); now += 101; releaseValidation(true);
  for (let i = 0; expiryRuntime.kernel.status(context, approvalRun.executionId).state !== 'EXPIRED' && i < 200; i++) await sleep(5);
  assert.equal(expiryRuntime.kernel.status(context, approvalRun.executionId).state, 'EXPIRED');
  assert.equal(executions, 2); await expiryRuntime.kernel.close(10);

  // State/version changes during validation invalidate its decision; stale denial cannot overwrite approval.
  const changedStore = new DurableStore(join(dir, 'validation-version.db'), { clock });
  const changedRun = changedStore.create(context, identity, null, 'changed');
  let releaseStale: ((allowed: boolean) => void) | undefined, validations = 0;
  const changedRuntime = createDurableKernel({ store: changedStore, authorize: () => ({ decision: 'ALLOW' }), revalidate: () => { validations++; return validations === 1 ? new Promise<boolean>(resolve => { releaseStale = resolve; }) : true; } });
  changedRuntime.kernel.register(cap);
  for (let i = 0; !releaseStale && i < 200; i++) await sleep(5);
  assert.ok(releaseStale);
  changedStore.awaitApproval(changedRun.executionId, 1, 'updated', now + 1000);
  const changedApproval = changedStore.internal(changedRun.executionId).approval!;
  changedRuntime.operator.decide({ approvalId: changedApproval.approvalId, expectedDecisionVersion: 1, decision: 'APPROVE', actor: 'operator' });
  releaseStale(false);
  for (let i = 0; changedRuntime.kernel.status(context, changedRun.executionId).state !== 'SUCCEEDED' && i < 200; i++) await sleep(5);
  assert.equal(changedRuntime.kernel.status(context, changedRun.executionId).state, 'SUCCEEDED');
  assert.equal(executions, 3); assert.ok(validations >= 3); await changedRuntime.kernel.close();

  // A reported failure after mutation explicitly preserves the possible partial-effects semantics.
  const partialRuntime = createDurableKernel({ store: new DurableStore(join(dir, 'partial.db')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  partialRuntime.kernel.register({ ...identity, execute: async () => { await appendFile(join(dir, 'partial-effect.txt'), 'partial'); throw new Error('sensitive diagnostic must not escape'); } });
  const partial = partialRuntime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'partial' });
  for (let i = 0; partialRuntime.kernel.status(context, partial.executionId).state !== 'FAILED' && i < 200; i++) await sleep(5);
  const failed = partialRuntime.kernel.status(context, partial.executionId);
  assert.equal(failed.state, 'FAILED');
  assert.deepEqual(failed.result, { code: 'HANDLER_ERROR', sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false });
  assert.equal(await readFile(join(dir, 'partial-effect.txt'), 'utf8'), 'partial'); await partialRuntime.kernel.close();

  const closedStore = new DurableStore(join(dir, 'closed.db'));
  const closedRuntime = createDurableKernel({ store: closedStore, authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  closedStore.close(); assert.equal(closedRuntime.kernel.health().executionAvailable, false); await closedRuntime.kernel.close();

  // Busy after a successful effect is not an execution failure receipt.
  const receiptPath = join(dir, 'receipt-busy.db');
  const receiptStore = new DurableStore(receiptPath);
  const receiptLocker = new DatabaseSync(receiptPath);
  let successfulEffect = false;
  const receiptRuntime = createDurableKernel({ store: receiptStore, authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  receiptRuntime.kernel.register({ ...identity, execute: async () => { successfulEffect = true; receiptLocker.exec('BEGIN IMMEDIATE'); return { completed: true }; } });
  const pendingReceipt = receiptRuntime.kernel.submit(context, { capability: 'write', input: null, idempotencyKey: 'receipt-busy' });
  for (let i = 0; receiptRuntime.kernel.health().executionAvailable && i < 200; i++) await sleep(5);
  assert.equal(successfulEffect, true); assert.equal(receiptRuntime.kernel.health().executionAvailable, false);
  assert.equal(receiptStore.internal(pendingReceipt.executionId).state, 'RUNNING');
  receiptLocker.exec('ROLLBACK');
  assert.equal(receiptLocker.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n, 0); receiptLocker.close();
  await receiptRuntime.kernel.close();
  const uncertain = new DurableStore(receiptPath);
  assert.equal(uncertain.status(context, pendingReceipt.executionId).state, 'UNKNOWN'); uncertain.close();

  const typed = createDurableKernel({ store: new DurableStore(join(dir, 'typed-outcomes.db')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true });
  typed.kernel.register({ ...identity, capability: 'unconfirmed', execute: async () => { throw new UnconfirmedOutcome('PROCESS_TREE_UNCONFIRMED', { processId: 'owned-process', treeTerminationConfirmed: false }); } });
  typed.kernel.register({ ...identity, capability: 'nonzero', execute: async () => { throw new ExecutionFailure('PROCESS_EXIT_NONZERO', { exitCode: 2, output: 'bounded output' }); } });
  const unknownTyped = typed.kernel.submit(context, { capability: 'unconfirmed', input: null, idempotencyKey: 'unknown' });
  const failedTyped = typed.kernel.submit(context, { capability: 'nonzero', input: null, idempotencyKey: 'failed' });
  for (let i = 0; typed.kernel.status(context, failedTyped.executionId).state !== 'FAILED' && i < 100; i++) await sleep(5);
  assert.equal(typed.kernel.status(context, unknownTyped.executionId).state, 'UNKNOWN');
  assert.deepEqual(typed.kernel.status(context, unknownTyped.executionId).result, { code: 'PROCESS_TREE_UNCONFIRMED', evidence: { processId: 'owned-process', treeTerminationConfirmed: false }, sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false });
  assert.deepEqual(typed.kernel.status(context, failedTyped.executionId).result, { code: 'PROCESS_EXIT_NONZERO', evidence: { exitCode: 2, output: 'bounded output' }, sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false });
  await typed.kernel.close();

  // A later DDL failure rolls back earlier tables and user_version atomically.
  const invalidPath = join(dir, 'invalid-schema.db');
  const invalid = new DatabaseSync(invalidPath);
  invalid.exec('CREATE TABLE runs(id TEXT);');
  assert.throws(() => new DurableStore(invalidPath));
  assert.equal(invalid.prepare('PRAGMA user_version').get()!.user_version, 0);
  assert.equal(invalid.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='events'").get()!.n, 0);
  invalid.close();
  console.log('v3-durable: durable recovery, idempotency, approval CAS, ownership, wait, cancellation, revocation and receipts passed');
} finally { await runtime.kernel.close(); await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }
}
if (process.env.P05_V3_DURABLE_CRASH_TEST) await crashChild(process.env.P05_V3_DURABLE_CRASH_TEST);
else await suite();
