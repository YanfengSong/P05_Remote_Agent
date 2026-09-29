import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DurableError, ExecutionDetached, ExecutionFailure, UnconfirmedOutcome, TERMINAL, type Capability, type ExecutionContext, type Json, type KernelOptions, type KernelHealth, type OperatorPort, type Owner, type Run, type SubmitRequest } from './types.js';
import { encode } from './store.js';

/** In-process trusted-host executor. It does not promise process survival or OS isolation. */
export class DurableKernel {
  private readonly capabilities = new Map<string, Capability>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly concurrency: number;
  private scheduled = false;
  private stopped = false;
  private disposed = false;
  private closing?: Promise<void>;
  private faultCode: string | null = null;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: KernelOptions) {
    this.concurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) throw new DurableError('INVALID_LIMIT', 'Concurrency must be 1..32');
    try { options.store.recover(); } catch (error) { options.store.close(); throw error; }
    this.timer = setInterval(() => { if (!this.stopped) { try { this.options.store.expire(); this.schedule(); } catch { this.stopForFault('STORAGE_SWEEP_FAILED'); } } }, 1000);
    this.timer.unref();
  }
  private stopForFault(code: string): void { this.stopped = true; this.faultCode ??= code; }
  health(): KernelHealth {
    const storage = this.options.store.health();
    if (!storage.available && !this.disposed) this.stopForFault(storage.faultCode ?? 'STORAGE_UNAVAILABLE');
    return { executionAvailable: !this.stopped && storage.available, scheduler: this.disposed ? 'CLOSED' : this.stopped ? 'STOPPED' : 'RUNNING', activeExecutions: this.active.size, faultCode: this.faultCode, storage };
  }
  private ensureOpen(): void { this.health(); if (this.stopped) throw new DurableError('KERNEL_CLOSED', 'Execution kernel is unavailable'); }
  private access<T>(body: () => T): T {
    this.ensureOpen();
    try { return body(); } catch (error) { if (!(error instanceof DurableError)) this.stopForFault('STORAGE_OPERATION_FAILED'); this.health(); throw error; }
  }
  register(capability: Capability): void {
    this.ensureOpen();
    if (this.capabilities.has(capability.capability)) throw new DurableError('DUPLICATE_CAPABILITY', 'Capability already registered');
    if (this.capabilities.size >= 512) throw new DurableError('CAPABILITY_LIMIT', 'At most 512 capabilities may be registered');
    this.capabilities.set(capability.capability, Object.freeze({ ...capability })); this.schedule();
  }
  submit(context: ExecutionContext, request: SubmitRequest): Run {
    this.ensureOpen();
    const c = this.capabilities.get(request.capability);
    if (!c) throw new DurableError('CAPABILITY_UNAVAILABLE', 'Capability is not registered');
    const run = this.access(() => this.options.store.create(context, { capability: c.capability, capabilityVersion: c.capabilityVersion, bindingVersion: c.bindingVersion }, request.input, request.idempotencyKey));
    this.schedule(); return run;
  }
  status(owner: Owner, id: string): Run { return this.access(() => { this.options.store.status(owner, id); this.options.store.expire(); return this.options.store.status(owner, id); }); }
  events(owner: Owner, id: string, afterSequence = 0, limit = 100) { return this.access(() => this.options.store.events(owner, id, afterSequence, limit)); }
  async wait(owner: Owner, id: string, afterVersion: number, waitMs: number): Promise<{ run: Run; waitOutcome: 'state_changed' | 'terminal' | 'timeout' }> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000 || !Number.isSafeInteger(afterVersion) || afterVersion < 0) throw new DurableError('INVALID_WAIT', 'Wait must be 0..30000 ms with a nonnegative state version');
    const deadline = performance.now() + waitMs;
    for (;;) {
      const run = this.status(owner, id);
      if (run.stateVersion > afterVersion) return { run, waitOutcome: 'state_changed' };
      if (TERMINAL.has(run.state)) return { run, waitOutcome: 'terminal' };
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { run, waitOutcome: 'timeout' };
      await sleep(Math.min(25, remaining));
    }
  }
  cancel(owner: Owner, id: string): Run { const r = this.access(() => this.options.store.cancel(owner, id)); this.active.get(id)?.controller.abort(); return r; }
  recover(): void {
    this.ensureOpen();
    if (this.active.size) throw new DurableError('RECOVERY_BUSY', 'Cannot recover while this kernel is executing');
    this.access(() => this.options.store.recover()); this.schedule();
  }
  /** Local transport must retain this capability object; do not register it as a remote tool. */
  operatorPort(): OperatorPort {
    return Object.freeze({
      pending: (slotId: string, limit?: number) => this.access(() => this.options.store.pending(slotId, limit)),
      decide: (request: Parameters<OperatorPort['decide']>[0]) => { const r = this.access(() => this.options.store.decide(request)); this.schedule(); return r; },
      reconcile: (request: Parameters<OperatorPort['reconcile']>[0]) => this.access(() => this.options.store.reconcile(request)),
    });
  }
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.stopped) return; try { this.ensureOpen(); this.pump(); } catch { this.stopForFault('DISPATCH_SCHEDULER_FAILED'); } });
  }
  private pump(): void {
    for (const run of this.options.store.queued(1000, [...this.capabilities.keys()])) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(run.executionId)) continue;
      const c = this.capabilities.get(run.capability);
      // An optional capability may register later. Never substitute another binding version.
      if (!c) continue;
      if (c.capabilityVersion !== run.capabilityVersion || c.bindingVersion !== run.bindingVersion) { this.options.store.failBeforeDispatch(run.executionId, run.stateVersion, 'PINNED_BINDING_UNAVAILABLE'); continue; }
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.execute(run, c, controller.signal)).finally(() => { this.active.delete(run.executionId); this.schedule(); });
      this.active.set(run.executionId, { controller, promise });
    }
  }
  private async execute(original: Run, capability: Capability, signal: AbortSignal): Promise<void> {
    const store = this.options.store;
    let attempt: string | undefined;
    try {
      let run = store.internal(original.executionId);
      if (run.state !== 'QUEUED' || this.stopped) return;
      // Hooks receive fresh JSON copies so modifying one cannot change stored execution intent.
      const initialVersion = run.stateVersion;
      const initiallyValid = await this.options.revalidate(Object.freeze(run), store.input(run.executionId));
      if (this.stopped) return;
      run = store.internal(run.executionId);
      if (run.state !== 'QUEUED' || run.stateVersion !== initialVersion) return;
      if (!initiallyValid) { store.deny(run.executionId, run.stateVersion, 'AUTHORIZATION_REVOKED_OR_PRECONDITION_CHANGED'); return; }
      // An approved one-shot grant is scoped to this immutable Run only. Revocation was checked above.
      if (run.approval?.status !== 'APPROVED') {
        const authorizationVersion = run.stateVersion;
        const decision = await this.options.authorize(Object.freeze(run), store.input(run.executionId));
        if (this.stopped) return;
        run = store.internal(run.executionId);
        if (run.state !== 'QUEUED' || run.stateVersion !== authorizationVersion) return;
        if (decision.decision === 'DENY') { store.deny(run.executionId, run.stateVersion, decision.reason); return; }
        if (decision.decision === 'CONFIRM') { store.awaitApproval(run.executionId, run.stateVersion, decision.reason, decision.expiresAt); return; }
        if (decision.decision !== 'ALLOW') throw new DurableError('INVALID_POLICY_DECISION', 'Unknown authorization decision');
      }
      // Revalidate immediately before the durable dispatch point, including after asynchronous policy evaluation.
      const dispatchVersion = run.stateVersion;
      const dispatchValid = await this.options.revalidate(Object.freeze(run), store.input(run.executionId));
      if (this.stopped) return;
      store.expire(); run = store.internal(run.executionId);
      if (run.state !== 'QUEUED' || run.stateVersion !== dispatchVersion) return;
      if (!dispatchValid) { store.deny(run.executionId, run.stateVersion, 'AUTHORIZATION_REVOKED_OR_PRECONDITION_CHANGED'); return; }
      attempt = store.dispatch(run.executionId, run.stateVersion);
      const result = await capability.execute({ run: Object.freeze(store.internal(run.executionId)), input: store.input(run.executionId), signal });
      encode(result);
      if (!this.disposed) store.finish(run.executionId, attempt, 'SUCCEEDED', result);
    } catch (error) {
      if (this.disposed) return;
      // A failed receipt write is uncertainty, never evidence that the executed action failed.
      if (!store.health().available) { this.stopForFault('STORAGE_EXECUTION_FAILED'); return; }
      try {
        const run = store.internal(original.executionId);
        // Error text may contain commands, tokens or payloads. Persist a stable code only.
        if (attempt && error instanceof UnconfirmedOutcome) store.unconfirmed(run.executionId, attempt, { code: error.code, evidence: error.evidence, sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false });
        else if (attempt) store.finish(run.executionId, attempt, 'FAILED', { code: error instanceof DurableError ? error.code : 'HANDLER_ERROR', sideEffectsMayHaveOccurred: true, automaticRetryAllowed: false, ...(error instanceof ExecutionFailure ? { evidence: error.evidence } : {}) });
        else if (run.state === 'QUEUED') store.failBeforeDispatch(run.executionId, run.stateVersion, error instanceof DurableError ? error.code : 'AUTHORIZATION_ERROR');
      } catch { this.stopForFault('STORAGE_RECEIPT_FAILED'); }
    }
  }
  /** Detach observation, bounded drain, then mark unfinished handlers UNKNOWN. */
  async close(drainMs = 1000): Promise<void> {
    if (this.closing) return this.closing;
    if (this.disposed) return;
    if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > 30000) throw new DurableError('INVALID_WAIT', 'Drain must be 0..30000 ms');
    this.closing = this.drainAndClose(drainMs);
    return this.closing;
  }
  private async drainAndClose(drainMs: number): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    for (const item of this.active.values()) item.controller.abort(new ExecutionDetached());
    const timeout = new AbortController();
    try { await Promise.race([Promise.allSettled([...this.active.values()].map(a => a.promise)), sleep(drainMs, undefined, { signal: timeout.signal })]); } finally { timeout.abort(); }
    try { if (this.options.store.health().state !== 'CLOSED') this.options.store.recover(); } finally { this.disposed = true; this.options.store.close(); }
  }
}
export function createDurableKernel(options: KernelOptions): { kernel: DurableKernel; operator: OperatorPort } {
  const kernel = new DurableKernel(options); return { kernel, operator: kernel.operatorPort() };
}
