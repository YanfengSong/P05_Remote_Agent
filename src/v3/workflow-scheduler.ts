import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Json, Owner, StateBackend, WorkflowRun } from "./workflows/types.js";

type RunState = WorkflowRun["state"];
const runStates = ["RUNNING", "WAITING_APPROVAL", "WAITING_EXECUTION", "PAUSED_UNKNOWN", "CANCEL_REQUESTED", "CANCELLED", "SUCCEEDED", "FAILED", "BUDGET_EXHAUSTED"] as const;
const terminal = new Set<RunState>(["CANCELLED", "SUCCEEDED", "FAILED", "BUDGET_EXHAUSTED"]);
const identity = z.string().min(1).max(160);
const entrySchema = z.object({
  runId: identity, phase: z.enum(["ACTIVE", "PAUSED_UNKNOWN", "PAUSED_ERROR"]), state: z.enum(runStates),
  trackedAt: z.number().int().nonnegative(), nextAt: z.number().int().nonnegative(), lastTickAt: z.number().int().nonnegative().nullable(),
  attempts: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), inFlight: z.boolean(), lastError: z.string().max(96).nullable(),
}).strict();
const indexSchema = z.object({
  schemaVersion: z.literal(1), owner: z.object({ principal: identity, slotId: identity }).strict(),
  generation: z.number().int().nonnegative(), claim: z.object({ coreInstanceId: identity, schedulerId: identity }).strict().nullable(),
  runs: z.array(entrySchema).max(4096),
  audit: z.array(z.object({ sequence: z.number().int().positive(), at: z.number().int().nonnegative(), runId: identity, event: z.string().max(96), state: z.enum(runStates).nullable(), code: z.string().max(96).nullable() }).strict()).max(4096),
  nextSequence: z.number().int().positive(), droppedAuditEvents: z.number().int().nonnegative(), completedRuns: z.number().int().nonnegative(),
}).strict();
type SchedulerIndex = z.infer<typeof indexSchema>;
type ScheduledRun = z.infer<typeof entrySchema>;

export interface WorkflowSchedulerOptions {
  state: StateBackend;
  owner: Owner;
  /** Trusted Core generation established under the Core's OS owner lock, never caller input. */
  generation: { coreInstanceId: string; instanceGeneration: number };
  /** Replay-safe durable orchestration tick. It must enforce ownership and never be raw OS effects. */
  advance(runId: string): Promise<{ state: RunState; runId?: string }>;
  intervalMs?: number;
  concurrency?: number;
  capacity?: number;
  auditCapacity?: number;
  tickTimeoutMs?: number;
  errorBackoffMs?: number;
  maxFailures?: number;
  now?: () => number;
}
export class WorkflowSchedulerError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkflowSchedulerError"; }
}

/** A bounded, owner-scoped background driver. It does not own or cancel external Runs.
 * Restart discovery can call track() for existing Workflow records. Persisted interrupted
 * ticks pause for explicit recovery; idle nonterminal entries resume automatically. */
export class WorkflowScheduler {
  private readonly options: WorkflowSchedulerOptions;
  private readonly namespace: string;
  private readonly schedulerId = randomUUID();
  private readonly active = new Map<string, Promise<void>>();
  private enabled = false;
  private detached = false;
  private lifecycle: "stopped" | "running" | "stopping" | "faulted" | "abandoned" = "stopped";
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private starting?: Promise<void>;
  private faultCode: string | null = null;
  private readonly limits: { interval: number; concurrency: number; capacity: number; auditCapacity: number; tickTimeout: number; backoff: number; maxFailures: number };

  constructor(options: WorkflowSchedulerOptions) {
    identity.parse(options.owner.principal); identity.parse(options.owner.slotId); identity.parse(options.generation.coreInstanceId);
    if (!Number.isSafeInteger(options.generation.instanceGeneration) || options.generation.instanceGeneration < 1) throw new WorkflowSchedulerError("INVALID_SCHEDULER_GENERATION");
    this.options = { ...options, owner: Object.freeze({ principal: options.owner.principal, slotId: options.owner.slotId }), generation: Object.freeze({ ...options.generation }) };
    const bound = (value: number | undefined, fallback: number, maximum: number) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new WorkflowSchedulerError("INVALID_SCHEDULER_LIMIT");
      return result;
    };
    this.limits = { interval: bound(options.intervalMs, 250, 60_000), concurrency: bound(options.concurrency, 4, 64), capacity: bound(options.capacity, 128, 4096), auditCapacity: bound(options.auditCapacity, 256, 4096), tickTimeout: bound(options.tickTimeoutMs, 30_000, 120_000), backoff: bound(options.errorBackoffMs, 1_000, 60_000), maxFailures: bound(options.maxFailures, 3, 100) };
    this.namespace = `workflow-scheduler:${createHash("sha256").update(JSON.stringify([options.owner.principal, options.owner.slotId])).digest("hex")}`;
  }

  private now(): number {
    const time = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(time) || time < 0) throw new WorkflowSchedulerError("INVALID_SCHEDULER_CLOCK");
    return time;
  }
  private empty(): SchedulerIndex { return { schemaVersion: 1, owner: { ...this.options.owner }, generation: 0, claim: null, runs: [], audit: [], nextSequence: 1, droppedAuditEvents: 0, completedRuns: 0 }; }
  private owned(index: SchedulerIndex): void {
    if (index.owner.principal !== this.options.owner.principal || index.owner.slotId !== this.options.owner.slotId) throw new WorkflowSchedulerError("SCHEDULER_OWNER_MISMATCH");
  }
  private claim(index: SchedulerIndex): void {
    this.owned(index);
    if (index.claim?.schedulerId !== this.schedulerId || index.claim.coreInstanceId !== this.options.generation.coreInstanceId || index.generation !== this.options.generation.instanceGeneration) throw new WorkflowSchedulerError("SCHEDULER_OWNERSHIP_LOST");
  }
  private async update(change: (index: SchedulerIndex) => void, requireClaim = true): Promise<SchedulerIndex> {
    for (let attempt = 0; attempt < 16; attempt++) {
      if (this.detached) throw new WorkflowSchedulerError("SCHEDULER_STATE_DETACHED");
      const stored = await this.options.state.read(this.namespace, "index-v1");
      if (this.detached) throw new WorkflowSchedulerError("SCHEDULER_STATE_DETACHED");
      const index = stored ? indexSchema.parse(stored.value) : this.empty();
      this.owned(index); if (requireClaim) this.claim(index);
      const before = JSON.stringify(index);
      change(index);
      if (before === JSON.stringify(index)) return index;
      if (await this.options.state.compareAndSet(this.namespace, "index-v1", stored?.version ?? null, index as unknown as Json)) return index;
    }
    throw new WorkflowSchedulerError("SCHEDULER_STATE_CONFLICT");
  }
  private record(index: SchedulerIndex, runId: string, event: string, state: RunState | null = null, code: string | null = null): void {
    if (!Number.isSafeInteger(index.nextSequence + 1)) throw new WorkflowSchedulerError("SCHEDULER_AUDIT_SEQUENCE_EXHAUSTED");
    index.audit.push({ sequence: index.nextSequence++, at: this.now(), runId, event, state, code });
    if (index.audit.length > this.limits.auditCapacity) {
      const excess = index.audit.length - this.limits.auditCapacity;
      index.audit.splice(0, excess); index.droppedAuditEvents += excess;
    }
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    const task = this.startInternal(); this.starting = task;
    try { await task; } finally { if (this.starting === task) this.starting = undefined; }
  }

  private async startInternal(): Promise<void> {
    if (this.detached) throw new WorkflowSchedulerError("SCHEDULER_STATE_DETACHED");
    if (this.enabled) return;
    if (this.active.size || this.lifecycle === "stopping") throw new WorkflowSchedulerError("SCHEDULER_STILL_DRAINING");
    await this.update((index) => {
      if (index.generation > this.options.generation.instanceGeneration) throw new WorkflowSchedulerError("STALE_SCHEDULER_GENERATION");
      if (index.generation === this.options.generation.instanceGeneration && index.claim && index.claim.schedulerId !== this.schedulerId) throw new WorkflowSchedulerError("SCHEDULER_ALREADY_OWNED");
      if (index.runs.length > this.limits.capacity) throw new WorkflowSchedulerError("SCHEDULER_RECOVERY_CAPACITY_EXCEEDED");
      index.generation = this.options.generation.instanceGeneration;
      index.claim = { coreInstanceId: this.options.generation.coreInstanceId, schedulerId: this.schedulerId };
      if (index.audit.length > this.limits.auditCapacity) { const excess = index.audit.length - this.limits.auditCapacity; index.audit.splice(0, excess); index.droppedAuditEvents += excess; }
      for (const run of index.runs) if (run.inFlight) {
        run.inFlight = false; run.phase = "PAUSED_UNKNOWN"; run.lastError = "INTERRUPTED_SCHEDULER_TICK";
        this.record(index, run.runId, "RECOVERED_UNCERTAIN_TICK", run.state, run.lastError);
      }
    }, false);
    this.faultCode = null; this.lifecycle = "running"; this.enabled = true; this.wake();
  }

  /** Idempotent index registration; tracking a paused entry never implicitly resumes it. */
  async track(runId: string, state: RunState = "RUNNING"): Promise<void> {
    identity.parse(runId); z.enum(runStates).parse(state);
    if (!this.enabled) throw new WorkflowSchedulerError("SCHEDULER_NOT_RUNNING");
    await this.update((index) => {
      const existing = index.runs.find((run) => run.runId === runId);
      if (existing) {
        if (state === "PAUSED_UNKNOWN") { existing.phase = "PAUSED_UNKNOWN"; existing.state = state; this.record(index, runId, "OBSERVED_UNKNOWN", state); }
        else if (terminal.has(state) && !existing.inFlight) { index.runs = index.runs.filter((run) => run.runId !== runId); index.completedRuns++; this.record(index, runId, "OBSERVED_TERMINAL_REMOVED", state); }
        return;
      }
      if (terminal.has(state)) { this.record(index, runId, "TRACK_TERMINAL_SKIPPED", state); return; }
      if (index.runs.length >= this.limits.capacity) throw new WorkflowSchedulerError("SCHEDULER_CAPACITY_EXCEEDED");
      const now = this.now();
      index.runs.push({ runId, state, phase: state === "PAUSED_UNKNOWN" ? "PAUSED_UNKNOWN" : "ACTIVE", trackedAt: now, nextAt: now, lastTickAt: null, attempts: 0, failures: 0, inFlight: false, lastError: null });
      this.record(index, runId, "TRACKED", state);
    });
    this.wake();
  }

  /** Explicit trusted resume requests a new orchestration tick, not replay of an OS action. */
  async resume(runId: string): Promise<void> {
    if (!this.enabled) throw new WorkflowSchedulerError("SCHEDULER_NOT_RUNNING");
    await this.update((index) => {
      const run = index.runs.find((entry) => entry.runId === runId);
      if (!run) throw new WorkflowSchedulerError("SCHEDULED_RUN_NOT_FOUND");
      if (run.inFlight || this.active.has(runId)) throw new WorkflowSchedulerError("SCHEDULED_RUN_STILL_IN_FLIGHT");
      run.phase = "ACTIVE"; run.failures = 0; run.lastError = null; run.nextAt = this.now();
      this.record(index, runId, "EXPLICIT_RESUME", run.state);
    });
    this.wake();
  }

  private wake(delay = 0): void {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pumping) { this.wake(this.limits.interval); return; }
      const task = this.pump(); this.pumping = task;
      void task.catch((error) => this.fault(error)).finally(() => { if (this.pumping === task) this.pumping = undefined; this.wake(this.limits.interval); });
    }, delay);
  }

  private async pump(): Promise<void> {
    if (!this.enabled || this.active.size >= this.limits.concurrency) return;
    let selected: string[] = [];
    await this.update((index) => {
      selected = index.runs.filter((run) => run.phase === "ACTIVE" && !run.inFlight && run.nextAt <= this.now() && !this.active.has(run.runId))
        .sort((a, b) => a.nextAt - b.nextAt || a.trackedAt - b.trackedAt || a.runId.localeCompare(b.runId))
        .slice(0, this.limits.concurrency - this.active.size).map((run) => run.runId);
      for (const run of index.runs) if (selected.includes(run.runId)) {
        run.inFlight = true; run.attempts++; run.lastTickAt = this.now();
      }
    });
    if (!this.enabled) {
      await this.update((index) => { for (const run of index.runs) if (selected.includes(run.runId)) run.inFlight = false; });
      return;
    }
    for (const id of selected) {
      const task = this.advance(id);
      this.active.set(id, task);
      void task.catch((error) => this.fault(error)).finally(() => {
        this.active.delete(id);
        if (this.enabled) this.wake();
      });
    }
  }

  private async advance(runId: string): Promise<void> {
    let timedOut = false;
    let timeoutWrite: Promise<unknown> | undefined;
    const timer = setTimeout(() => {
      if (this.detached) return;
      timedOut = true;
      timeoutWrite = this.update((index) => {
        const run = index.runs.find((entry) => entry.runId === runId); if (!run) return;
        run.phase = "PAUSED_UNKNOWN"; run.lastError = "SCHEDULER_TICK_TIMEOUT";
        this.record(index, runId, "TICK_TIMEOUT_NO_CANCELLATION", run.state, run.lastError);
      });
      void timeoutWrite.catch((error) => this.fault(error));
    }, this.limits.tickTimeout);
    let result: { state: RunState; runId?: string } | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await Promise.resolve().then(() => this.options.advance(runId));
      if (!result || !runStates.includes(result.state) || (result.runId !== undefined && result.runId !== runId)) throw new WorkflowSchedulerError("INVALID_SCHEDULER_TICK_RESULT");
    } catch (error) { failed = true; failure = error; }
    finally { clearTimeout(timer); }
    if (timeoutWrite) await timeoutWrite;
    if (this.detached) return;
    await this.update((index) => {
      const run = index.runs.find((entry) => entry.runId === runId); if (!run) throw new WorkflowSchedulerError("SCHEDULED_RUN_DISAPPEARED");
      run.inFlight = false;
      if (failed) {
        run.failures++;
        const code = (failure as { code?: unknown })?.code;
        run.lastError = typeof code === "string" && /^[A-Z0-9_]{1,96}$/.test(code) ? code : "WORKFLOW_TICK_FAILED";
        if (timedOut) run.phase = "PAUSED_UNKNOWN";
        else if (run.failures >= this.limits.maxFailures) run.phase = "PAUSED_ERROR";
        run.nextAt = this.now() + Math.min(60_000, this.limits.backoff * 2 ** Math.min(run.failures - 1, 10));
        this.record(index, runId, run.phase === "ACTIVE" ? "TICK_RETRY_BACKOFF" : "TICK_PAUSED", run.state, run.lastError);
      } else {
        run.state = result!.state;
        if (terminal.has(run.state)) {
          index.runs = index.runs.filter((entry) => entry.runId !== runId); index.completedRuns++;
          this.record(index, runId, "TERMINAL_REMOVED_FROM_ACTIVE_INDEX", run.state);
        } else {
          run.failures = 0; run.nextAt = this.now() + this.limits.interval;
          if (timedOut || run.state === "PAUSED_UNKNOWN") run.phase = "PAUSED_UNKNOWN";
          if (!timedOut) run.lastError = null;
          this.record(index, runId, run.phase === "PAUSED_UNKNOWN" ? "PAUSED_UNKNOWN" : "TICK_COMPLETED", run.state);
        }
      }
    });
  }

  private fault(error: unknown): void {
    if (this.detached) return;
    this.faultCode = error instanceof WorkflowSchedulerError ? error.code : "SCHEDULER_STATE_UNAVAILABLE";
    this.enabled = false; this.lifecycle = "faulted"; if (this.timer) clearTimeout(this.timer);
  }

  /** Stops admissions only. A timeout permanently detaches this object's StateBackend:
   * late callbacks cannot start another state read/write, and persisted inFlight markers
   * remain for the next Core generation to recover as UNKNOWN. The callback itself must
   * also use a fenced backend if it may outlive Core shutdown. No executor cancellation. */
  async stop(options: { waitMs?: number } = {}): Promise<{ drained: boolean; inFlight: number }> {
    const waitMs = options.waitMs ?? 5_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new WorkflowSchedulerError("INVALID_SCHEDULER_DRAIN_TIMEOUT");
    if (this.detached) return { drained: this.active.size === 0 && !this.pumping, inFlight: this.active.size };
    if (this.starting) await this.starting;
    if (this.lifecycle === "stopped" && this.active.size === 0) return { drained: true, inFlight: 0 };
    this.enabled = false; this.lifecycle = "stopping"; if (this.timer) clearTimeout(this.timer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingPump = this.pumping;
    const drain = async () => {
      if (pendingPump) await pendingPump.catch(() => undefined);
      await Promise.allSettled([...this.active.values()]);
      return true;
    };
    let drained: boolean;
    try { drained = await Promise.race([drain(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); })]); }
    finally { if (timer) clearTimeout(timer); }
    if (drained) {
      await this.update((index) => { index.claim = null; });
      this.lifecycle = "stopped";
    } else { this.detached = true; this.lifecycle = "abandoned"; }
    return { drained, inFlight: this.active.size };
  }

  async status() {
    if (this.detached) throw new WorkflowSchedulerError("SCHEDULER_STATE_DETACHED");
    const row = await this.options.state.read(this.namespace, "index-v1");
    const index = row ? indexSchema.parse(row.value) : this.empty(); this.owned(index);
    return { lifecycle: this.lifecycle, enabled: this.enabled, owner: { ...this.options.owner }, generation: this.options.generation.instanceGeneration,
      inFlight: this.active.size, concurrency: this.limits.concurrency, capacity: this.limits.capacity, faultCode: this.faultCode,
      runs: index.runs, audit: index.audit, droppedAuditEvents: index.droppedAuditEvents, completedRuns: index.completedRuns,
      auditRetentionBound: this.limits.auditCapacity, lastAuditSequence: index.nextSequence - 1 };
  }
}
