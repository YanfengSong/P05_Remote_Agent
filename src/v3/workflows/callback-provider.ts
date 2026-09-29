import { copy, digest } from './registry.js';
import { WorkflowError, type AgentProvider, type ExecutionRequest, type ExecutionSnapshot, type Json, type StateBackend, type WorkflowContext } from './types.js';

interface Record { context: WorkflowContext; intentDigest: string; snapshot: ExecutionSnapshot }
/** Local test/integration provider. A callback is trusted code, not an OS-isolated commercial agent. */
export class CallbackAgentProvider implements AgentProvider {
  readonly providerId: string;
  readonly revision: string;
  private readonly active = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly options: { providerId: string; revision: string; state: StateBackend; execute(request: ExecutionRequest, signal: AbortSignal): Promise<Json> }) { this.providerId = options.providerId; this.revision = options.revision; }
  private namespace(c: WorkflowContext): string { return 'agent:' + digest({ provider: this.providerId, revision: this.revision, principal: c.principal, slotId: c.slotId }); }
  private id(key: string): string { return 'agent-' + digest(key); }
  async submit(request: ExecutionRequest): Promise<ExecutionSnapshot> {
    if (this.closed || request.capability !== this.providerId || request.capabilityVersion !== this.revision) throw new WorkflowError('PROVIDER_UNAVAILABLE', 'Pinned callback provider unavailable');
    const namespace = this.namespace(request.context), id = this.id(request.idempotencyKey), intentDigest = digest(request);
    const existing = await this.options.state.read(namespace, id);
    if (existing) { if ((existing.value as unknown as Record).intentDigest !== intentDigest) throw new WorkflowError('IDEMPOTENCY_CONFLICT', 'Provider key intent changed'); return this.status(request.context, id); }
    const record: Record = { context: copy(request.context), intentDigest, snapshot: { executionId: id, state: 'RUNNING' } };
    if (!await this.options.state.compareAndSet(namespace, id, null, copy(record) as unknown as Json)) return this.submit(request);
    const controller = new AbortController(); this.active.set(id, controller);
    const task = Promise.resolve().then(async () => {
      let snapshot: ExecutionSnapshot;
      try { const result = await this.options.execute(copy(request), controller.signal); snapshot = { executionId: id, state: 'SUCCEEDED', result: copy(result) }; }
      catch { snapshot = { executionId: id, state: 'FAILED', safeRetry: false, result: { code: 'CALLBACK_FAILED', sideEffectsMayHaveOccurred: true } }; }
      if (this.closed) return;
      const latest = await this.options.state.read(namespace, id);
      if (!latest) return;
      const value = latest.value as unknown as Record;
      if (!['RUNNING', 'CANCEL_REQUESTED'].includes(value.snapshot.state)) return;
      value.snapshot = snapshot;
      await this.options.state.compareAndSet(namespace, id, latest.version, copy(value) as unknown as Json);
    }).finally(() => { this.active.delete(id); this.tasks.delete(task); });
    this.tasks.add(task); void task.catch(() => {});
    return copy(record.snapshot);
  }
  async status(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    const namespace = this.namespace(context), stored = await this.options.state.read(namespace, executionId);
    if (!stored) throw new WorkflowError('NOT_FOUND', 'Provider invocation not found');
    const record = stored.value as unknown as Record;
    if (digest(record.context) !== digest(context)) throw new WorkflowError('NOT_FOUND', 'Provider invocation context mismatch');
    if (['RUNNING', 'CANCEL_REQUESTED'].includes(record.snapshot.state) && !this.active.has(executionId)) {
      record.snapshot.state = 'UNKNOWN';
      if (!await this.options.state.compareAndSet(namespace, executionId, stored.version, copy(record) as unknown as Json)) return this.status(context, executionId);
    }
    return copy(record.snapshot);
  }
  async find(context: WorkflowContext, key: string): Promise<ExecutionSnapshot | undefined> { return (await this.options.state.read(this.namespace(context), this.id(key))) ? this.status(context, this.id(key)) : undefined; }
  async cancel(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    const snapshot = await this.status(context, executionId);
    if (!['RUNNING', 'CANCEL_REQUESTED'].includes(snapshot.state)) return snapshot;
    const namespace = this.namespace(context), stored = await this.options.state.read(namespace, executionId);
    if (!stored) throw new WorkflowError('NOT_FOUND', 'Provider invocation not found');
    const record = stored.value as unknown as Record;
    // Completion may have committed between status() and this second read.
    if (!['RUNNING', 'CANCEL_REQUESTED'].includes(record.snapshot.state)) return copy(record.snapshot);
    record.snapshot.state = 'CANCEL_REQUESTED';
    if (!await this.options.state.compareAndSet(namespace, executionId, stored.version, copy(record) as unknown as Json)) return this.cancel(context, executionId);
    this.active.get(executionId)?.abort(); return copy(record.snapshot);
  }
  /** Stop ownership; unfinished callbacks become UNKNOWN on the next status, never replayed. */
  close(): void { this.closed = true; for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
}
