import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoreState } from "../v3/core/state.js";
import { WorkflowScheduler, type WorkflowSchedulerOptions } from "../v3/workflow-scheduler.js";
import type { Json, StateBackend } from "../v3/workflows/types.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "p05-scheduler-"));
const stateDir = path.join(directory, "state");
const workspace = path.join(directory, "workspace");
mkdirSync(workspace);
const cores: CoreState[] = [];
const schedulers: WorkflowScheduler[] = [];
const releases: (() => void)[] = [];
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4_000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error("CONDITION_TIMEOUT"); await sleep(5); }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; }); releases.push(release);
  return { promise, release };
}
function open(slotId: string) {
  const core = CoreState.open({ stateDir, slotId, workspaceRoots: [workspace] }); cores.push(core); return core;
}
function backend(core: CoreState) {
  const activity = { calls: 0 };
  const key = (namespace: string, name: string) => `service:scheduler:${createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex")}`;
  const state: StateBackend = {
    read: async (namespace, name) => { activity.calls++; return core.readVersioned<Json>(key(namespace, name)); },
    compareAndSet: async (namespace, name, version, value) => { activity.calls++; return core.compareAndSet(key(namespace, name), version, value); },
  };
  return { state, activity };
}
function create(core: CoreState, advance: WorkflowSchedulerOptions["advance"], extra: Partial<WorkflowSchedulerOptions> = {}) {
  const storage = backend(core);
  const scheduler = new WorkflowScheduler({ state: storage.state, owner: { principal: "operator", slotId: core.identity.slotId }, generation: core.identity,
    advance, intervalMs: 8, tickTimeoutMs: 1_000, errorBackoffMs: 8, ...extra });
  schedulers.push(scheduler);
  return { scheduler, ...storage };
}

try {
  const core = open("basic");
  let calls = 0;
  const extraOwner = { principal: "operator", slotId: "basic", workspaceRoot: "must-not-persist" };
  const { scheduler } = create(core, async () => ({ state: ++calls >= 3 ? "SUCCEEDED" : "WAITING_EXECUTION" }), { owner: extraOwner });
  await Promise.all([scheduler.start(), scheduler.start()]);
  await scheduler.track("periodic");
  await until(async () => (await scheduler.status()).completedRuns === 1);
  check(calls === 3 && (await scheduler.status()).runs.length === 0, "periodic ticks progress and terminal entry leaves active index");
  check(!JSON.stringify(await scheduler.status()).includes("must-not-persist"), "runtime owner is projected to immutable trusted identity");
  const duplicate = create(core, async () => ({ state: "SUCCEEDED" })).scheduler;
  await assert.rejects(duplicate.start(), /SCHEDULER_ALREADY_OWNED/); checks++;
  check((await scheduler.stop()).drained, "clean stop drains and releases claim");

  const parallelCore = open("parallel");
  const held = gate();
  let concurrent = 0, peak = 0;
  const perRun = new Map<string, number>();
  const parallel = create(parallelCore, async (id) => {
    perRun.set(id, (perRun.get(id) ?? 0) + 1); concurrent++; peak = Math.max(peak, concurrent);
    await held.promise; concurrent--; return { state: "SUCCEEDED" };
  }, { concurrency: 2 }).scheduler;
  await parallel.start();
  await Promise.all([parallel.track("a"), parallel.track("a"), parallel.track("b"), parallel.track("c")]);
  await until(() => concurrent === 2); await sleep(30);
  check(peak === 2 && [...perRun.values()].every((n) => n === 1), "concurrency cap and duplicate tracking prevent overlapping same-run ticks");
  held.release();
  await until(async () => (await parallel.status()).completedRuns === 3);
  check([...perRun.values()].every((n) => n === 1), "each bounded run starts exactly once");
  await parallel.stop();

  const unknownCore = open("unknown");
  let unknownCalls = 0;
  const unknown = create(unknownCore, async () => ({ state: ++unknownCalls === 1 ? "PAUSED_UNKNOWN" : "SUCCEEDED" })).scheduler;
  await unknown.start(); await unknown.track("uncertain");
  await until(async () => (await unknown.status()).runs[0]?.phase === "PAUSED_UNKNOWN");
  await unknown.track("uncertain", "RUNNING"); await sleep(45);
  check(unknownCalls === 1, "UNKNOWN and ordinary retracking never busy-loop or implicitly resume");
  await unknown.resume("uncertain");
  await until(async () => (await unknown.status()).completedRuns === 1);
  check(unknownCalls === 2, "explicit resume permits next durable tick");
  await unknown.stop();

  const failureCore = open("failure");
  let badCalls = 0, goodCalls = 0;
  const failures = create(failureCore, async (id) => {
    if (id === "bad") { badCalls++; throw undefined; }
    goodCalls++; return { state: "SUCCEEDED" };
  }, { maxFailures: 3 }).scheduler;
  await failures.start(); await failures.track("bad"); await failures.track("good");
  await until(async () => (await failures.status()).runs[0]?.phase === "PAUSED_ERROR");
  await sleep(30);
  check(badCalls === 3 && goodCalls === 1 && (await failures.status()).completedRuns === 1, "throw undefined is counted, bounded retries isolate bad Workflow from good one");
  await failures.stop();

  const restartCore = open("restart");
  let beforeRestart = 0;
  const restart = create(restartCore, async () => { beforeRestart++; return { state: "WAITING_APPROVAL" }; }, { intervalMs: 50 }).scheduler;
  await restart.start(); await restart.track("waiting");
  await until(() => beforeRestart === 1); await restart.stop(); restartCore.close();
  const reopened = open("restart");
  let resumed = 0;
  const recovered = create(reopened, async () => { resumed++; return { state: "SUCCEEDED" }; }).scheduler;
  await recovered.start();
  await until(async () => (await recovered.status()).completedRuns === 1);
  check(resumed === 1 && reopened.identity.instanceGeneration === 2, "real SQLite/Core reopen automatically discovers and advances idle unfinished index");
  const stale = create(reopened, async () => ({ state: "SUCCEEDED" }), { generation: restartCore.identity }).scheduler;
  await assert.rejects(stale.start(), /STALE_SCHEDULER_GENERATION/); checks++;
  await recovered.stop();

  const abandonedCore = open("abandon");
  const unfinished = gate(); let ended = false, admitted = 0;
  const abandoned = create(abandonedCore, async () => { admitted++; await unfinished.promise; ended = true; return { state: "SUCCEEDED" }; }, { concurrency: 1, tickTimeoutMs: 20 });
  await abandoned.scheduler.start(); await abandoned.scheduler.track("held"); await abandoned.scheduler.track("queued");
  await until(() => admitted === 1);
  const stop = await abandoned.scheduler.stop({ waitMs: 1 });
  check(!stop.drained && stop.inFlight === 1 && !ended, "bounded stop does not abort external callback or admit queued Run");
  const callsAtClose = abandoned.activity.calls;
  abandonedCore.close();
  await sleep(35); unfinished.release(); await until(() => ended); await sleep(10);
  check(abandoned.activity.calls === callsAtClose && admitted === 1, "timeout and late completion never access detached StateBackend after Core close");
  await assert.rejects(abandoned.scheduler.start(), /SCHEDULER_STATE_DETACHED/); checks++;
  check((await abandoned.scheduler.stop()).drained, "repeated stop after abandoned callback settles performs local cleanup only");
  const afterAbandon = open("abandon");
  const afterCalls: string[] = [];
  const after = create(afterAbandon, async (id) => { afterCalls.push(id); return { state: "SUCCEEDED" }; }).scheduler;
  await after.start();
  await until(async () => (await after.status()).completedRuns === 1);
  const pausedAfter = (await after.status()).runs[0];
  check(pausedAfter.runId === "held" && pausedAfter.phase === "PAUSED_UNKNOWN" && afterCalls.join() === "queued", "persisted interrupted tick pauses on restart while idle queued Run progresses");
  await after.resume("held"); await until(async () => (await after.status()).completedRuns === 2);
  check(afterCalls.join() === "queued,held", "operator resume recovers abandoned tick through durable orchestration callback");
  await after.stop();

  const timeoutCore = open("timeout"); const late = gate();
  let longCalls = 0;
  const timeout = create(timeoutCore, async (id) => {
    if (id === "long") { longCalls++; await late.promise; return { state: "WAITING_EXECUTION" }; }
    return { state: "SUCCEEDED" };
  }, { tickTimeoutMs: 15, concurrency: 2 }).scheduler;
  await timeout.start(); await timeout.track("long"); await timeout.track("short");
  await until(async () => { const s = await timeout.status(); return s.completedRuns === 1 && s.runs[0]?.phase === "PAUSED_UNKNOWN"; });
  check((await timeout.status()).inFlight === 1 && longCalls === 1, "timeout quarantines scheduling and retains real in-flight concurrency slot");
  await assert.rejects(timeout.resume("long"), /SCHEDULED_RUN_STILL_IN_FLIGHT/); checks++;
  late.release(); await until(async () => (await timeout.status()).inFlight === 0); await sleep(30);
  check((await timeout.status()).runs[0].phase === "PAUSED_UNKNOWN" && longCalls === 1, "late nonterminal result does not silently resume timed-out Run");
  await timeout.stop();

  const boundedCore = open("bounded");
  const bounded = create(boundedCore, async () => ({ state: "SUCCEEDED" }), { capacity: 2, auditCapacity: 4 }).scheduler;
  await bounded.start(); await bounded.track("p1", "PAUSED_UNKNOWN"); await bounded.track("p2", "PAUSED_UNKNOWN");
  await assert.rejects(bounded.track("over", "PAUSED_UNKNOWN"), /SCHEDULER_CAPACITY_EXCEEDED/); checks++;
  for (let i = 0; i < 12; i++) await bounded.track(`terminal-${i}`, "SUCCEEDED");
  const summary = await bounded.status();
  check(summary.runs.length === 2 && summary.audit.length === 4 && summary.droppedAuditEvents === 10, "bounded audit ring and aggregate counters avoid unbounded terminal state growth");
  await bounded.stop();

  const delayedCore = open("delayed-backend");
  const delayedStorage = backend(delayedCore); const readGate = gate();
  let delayReads = false, readStarted = false;
  const delayedState: StateBackend = {
    read: async (namespace, key) => {
      const row = await delayedStorage.state.read(namespace, key);
      if (delayReads) { readStarted = true; await readGate.promise; }
      return row;
    },
    compareAndSet: delayedStorage.state.compareAndSet,
  };
  const delayed = create(delayedCore, async () => ({ state: "SUCCEEDED" }), { state: delayedState }).scheduler;
  await delayed.start(); delayReads = true;
  await until(() => readStarted);
  check(!(await delayed.stop({ waitMs: 1 })).drained, "stop deadline includes a pending scheduler state read");
  const callsBeforeRelease = delayedStorage.activity.calls;
  delayedCore.close(); readGate.release(); await sleep(15);
  check(delayedStorage.activity.calls === callsBeforeRelease, "late backend read cannot start a subsequent CAS after shutdown fence");
  console.log(`V3 Workflow Scheduler: ${checks} checks passed`);
} finally {
  for (const release of releases) release();
  for (const scheduler of schedulers) await scheduler.stop({ waitMs: 50 }).catch(() => undefined);
  for (const core of cores) core.close();
  rmSync(directory, { recursive: true, force: true });
}
