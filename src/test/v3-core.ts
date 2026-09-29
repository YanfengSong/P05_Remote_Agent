import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreRuntime, CoreState, CoreStateError, ManagedServiceController, RestartBudget, type ManagedServiceAdapter } from "../v3/core/index.js";

if (process.argv[2] === "--owner-child") {
  try {
    const state = CoreState.open({ stateDir: process.argv[3], slotId: process.argv[4], workspaceRoots: [process.argv[5]] });
    process.send?.({ ok: true, identity: state.identity });
    setInterval(() => undefined, 1_000);
  } catch (error) {
    process.send?.({ ok: false, code: error instanceof CoreStateError ? error.code : "ERROR" });
    process.disconnect?.();
  }
} else {
  const directory = mkdtempSync(path.join(os.tmpdir(), "p05-v3-core-"));
  const stateDir = path.join(directory, "state");
  const workspace = path.join(directory, "workspace");
  mkdirSync(workspace);
  const workspaceRoots = [workspace];
  const testProtection = async () => ({ verified: true, code: "TEST_TEMP_DIRECTORY" });
  const cores: CoreRuntime[] = [];
  const children: ChildProcess[] = [];
  let checks = 0;
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };

  async function ownerChild(slotId: string) {
    const child = fork(fileURLToPath(import.meta.url), ["--owner-child", stateDir, slotId, workspace], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    const reply = await new Promise<{ ok: boolean; code?: string; identity?: { coreInstanceId: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CHILD_START_TIMEOUT")), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("message", (message) => { clearTimeout(timer); resolve(message as { ok: boolean }); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("CHILD_EXIT_BEFORE_READY")); });
    });
    return { child, reply };
  }

  async function killOwned(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }

  try {
    assert.throws(() => CoreState.open({ stateDir: path.join(workspace, "forbidden-state"), slotId: "A", workspaceRoots }), /disjoint/); checks++;
    assert.throws(() => CoreState.open({ stateDir, slotId: "../escape", workspaceRoots }), /identifier/); checks++;

    const a = await CoreRuntime.start({ stateDir, slotId: "A", workspaceRoots, verifyProtection: testProtection, connectOptional: async () => { throw new Error("plugin secret must not leak"); } });
    cores.push(a);
    await a.optionalSettled;
    check(a.status().mode === "DEGRADED" && a.status().readiness.recovery && a.status().readiness.mutations, "optional failure keeps trusted Core available");
    check(!JSON.stringify(a.status()).includes("plugin secret"), "diagnostics do not leak optional exception details");
    const b = await CoreRuntime.start({ stateDir, slotId: "B", workspaceRoots, verifyProtection: testProtection });
    cores.push(b);
    check(a.state.identity.hostId === b.state.identity.hostId, "Slots share persisted Host identity");
    check(a.state.identity.coreInstanceId !== b.state.identity.coreInstanceId && a.state.identity.slotId !== b.state.identity.slotId, "Slots have independent identities");
    check(a.state.identity.instanceGeneration === 1 && b.state.identity.instanceGeneration === 1, "initial generation per Slot");
    assert.throws(() => CoreState.open({ stateDir, slotId: "A", workspaceRoots }), (error) => error instanceof CoreStateError && error.code === "SLOT_ALREADY_OWNED"); checks++;
    const contender = await ownerChild("A");
    check(!contender.reply.ok && contender.reply.code === "SLOT_ALREADY_OWNED", "OS lock rejects another process for same Slot");

    const hostId = a.state.identity.hostId;
    check(a.state.compareAndSet("service:workflow:test", null, { stage: 1 }), "CAS creates an absent record");
    check(!a.state.compareAndSet("service:workflow:test", null, { stage: 999 }), "CAS rejects duplicate absent expectation");
    const versioned = a.state.readVersioned<{ stage: number }>("service:workflow:test")!;
    check(versioned.version === 1 && versioned.value.stage === 1, "versioned read returns committed value and version");
    check(a.state.compareAndSet("service:workflow:test", 1, { stage: 2 }) && !a.state.compareAndSet("service:workflow:test", 1, { stage: 3 }), "only one writer using the same observed version wins");
    assert.throws(() => a.state.compareAndSet("owner", null, {}), /mutable Core namespace/); checks++;
    a.close();
    check(b.status().liveness && b.status().mode === "NORMAL", "closing A does not disturb B");
    const a2 = await CoreRuntime.start({ stateDir, slotId: "A", workspaceRoots, verifyProtection: testProtection });
    cores.push(a2);
    check(a2.state.identity.hostId === hostId && a2.state.identity.instanceGeneration === 2, "clean restart preserves identity and increments generation");
    check(a2.state.readVersioned<{ stage: number }>("service:workflow:test")?.value.stage === 2 && a2.state.readVersioned("service:workflow:test")?.version === 2, "CAS state and version survive restart");
    a2.state.put("service:workflow:test", { stage: 4 });
    check(a2.state.readVersioned("service:workflow:test")?.version === 3 && !a2.state.compareAndSet("service:workflow:test", 2, {}), "ordinary put participates in version advancement");
    a2.state.put("service:page:a", { n: 1 }); a2.state.put("service:page:b", { n: 2 });
    const page1 = a2.state.listVersioned<{ n: number }>("service:page:", undefined, 1);
    const page2 = a2.state.listVersioned<{ n: number }>("service:page:", page1[0].key, 1);
    check(page1[0].value.n === 1 && page2[0].value.n === 2 && a2.state.listVersioned("service:page:", page2[0].key, 1).length === 0, "key cursor pagination reads persistent records exactly once");
    assert.throws(() => a2.state.listVersioned("owner"), /mutable Core namespace/); checks++;
    assert.throws(() => a2.state.listVersioned("service:", undefined, 101), /between 1 and 100/); checks++;
    assert.throws(() => a2.state.listVersioned("service:page:", "supervision:other"), /selected prefix/); checks++;

    const crashed = await ownerChild("C");
    check(crashed.reply.ok, "separate process owns Slot C");
    await killOwned(crashed.child);
    let previousOwnerId: string | undefined;
    assert.throws(() => CoreState.open({ stateDir, slotId: "C", workspaceRoots }), (error) => {
      if (!(error instanceof CoreStateError) || error.code !== "UNCLEAN_OWNER_REQUIRES_MAINTENANCE") return false;
      previousOwnerId = error.previousOwnerId;
      return true;
    }); checks++;
    check(previousOwnerId === crashed.reply.identity?.coreInstanceId, "unclean recovery binds exact old owner, not PID or TTL");
    assert.throws(() => CoreState.open({ stateDir, slotId: "C", workspaceRoots, recoverUncleanOwner: { coreInstanceId: "wrong-owner", reason: "test" } }), (error) => error instanceof CoreStateError && error.code === "RECOVERY_OWNER_MISMATCH"); checks++;
    assert.throws(() => CoreState.open({ stateDir, slotId: "C", workspaceRoots, recoverUncleanOwner: { coreInstanceId: previousOwnerId!, reason: " " } }), (error) => error instanceof CoreStateError && error.code === "RECOVERY_OWNER_MISMATCH"); checks++;
    const c = await CoreRuntime.start({ stateDir, slotId: "C", workspaceRoots, verifyProtection: testProtection, recoverUncleanOwner: { coreInstanceId: previousOwnerId!, reason: "Test child killed; no execution children exist" } });
    cores.push(c);
    check(c.state.identity.instanceGeneration === 2, "OS lock release plus explicit recovery permits new generation");
    c.close();
    assert.throws(() => CoreState.open({ stateDir, slotId: "C", workspaceRoots, recoverUncleanOwner: { coreInstanceId: previousOwnerId!, reason: "stale inspection" } }), (error) => error instanceof CoreStateError && error.code === "RECOVERY_NOT_REQUIRED"); checks++;
    const cNormal = CoreState.open({ stateDir, slotId: "C", workspaceRoots });
    check(cNormal.identity.instanceGeneration === 3, "released owner still permits ordinary startup after stale recovery rejection");
    cNormal.close();
    assert.throws(() => CoreState.open({ stateDir, slotId: "never-started", workspaceRoots, recoverUncleanOwner: { coreInstanceId: previousOwnerId!, reason: "no prior owner" } }), (error) => error instanceof CoreStateError && error.code === "RECOVERY_NOT_REQUIRED"); checks++;

    const brokenFile = path.join(stateDir, "slots", "broken", "core.sqlite");
    mkdirSync(brokenFile, { recursive: true });
    assert.throws(() => CoreState.open({ stateDir, slotId: "broken", workspaceRoots })); checks++;
    rmSync(brokenFile, { recursive: true });
    const repaired = CoreState.open({ stateDir, slotId: "broken", workspaceRoots });
    check(repaired.identity.instanceGeneration === 1, "failed state open releases OS ownership handle");
    repaired.close();

    let optionalCalled = false;
    const locked = await CoreRuntime.start({ stateDir, slotId: "locked", workspaceRoots, connectOptional: async () => { optionalCalled = true; } });
    cores.push(locked);
    check(locked.status().mode === "LOCKED" && !locked.status().readiness.mutations && !optionalCalled, "missing protection attestation fails closed");
    check(!locked.status().isolationVerified && locked.status().securityMode === "trusted-host", "directory checks never claim OS sandbox");
    const recovery = await CoreRuntime.start({ stateDir, slotId: "recovery", workspaceRoots, verifyProtection: testProtection, recoveryMode: true, connectOptional: async () => { optionalCalled = true; } });
    cores.push(recovery);
    check(recovery.status().mode === "RECOVERY" && !optionalCalled && !recovery.status().readiness.mutations, "safe boot excludes optional services and generic mutations");
    const hanging = await CoreRuntime.start({ stateDir, slotId: "hanging", workspaceRoots, verifyProtection: testProtection, optionalTimeoutMs: 20, connectOptional: async () => new Promise<void>(() => undefined) });
    cores.push(hanging);
    await hanging.optionalSettled;
    check(hanging.status().mode === "DEGRADED", "unresponsive optional connector is bounded");

    let now = 1_000;
    const budget = new RestartBudget({ now: () => now, random: () => 0 });
    now += 30_000;
    check(budget.snapshot().state === "suspect", "heartbeat absence is separate suspect state");
    budget.recordCrash();
    check(!budget.canRestart(), "first crash backs off");
    now += 1_000;
    check(budget.canRestart(), "bounded backoff expires");
    budget.recordCrash(); budget.recordCrash();
    now += 600_000;
    check(budget.snapshot().state === "crash_loop" && !budget.canRestart(), "crash-loop remains latched until maintenance");
    budget.reset();
    check(budget.canRestart(), "explicit reset permits recovery");

    let serviceProcess: ChildProcess | undefined;
    let starts = 0;
    let stops = 0;
    const adapter: ManagedServiceAdapter = {
      observe: async () => ({ state: serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null ? "running" : "stopped", healthy: !!serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null }),
      start: async () => {
        starts++;
        serviceProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        children.push(serviceProcess);
        await once(serviceProcess, "spawn");
      },
      stop: async () => { stops++; if (serviceProcess) await killOwned(serviceProcess); },
    };
    const services = new ManagedServiceController(a2.state, { scope: "slot", ownerId: "A" }, { now: () => now, random: () => 0 });
    services.register({ serviceId: "test-child", version: "1", scope: "slot", ownerId: "A", dependencies: [] }, adapter);
    assert.throws(() => services.register({ serviceId: "foreign", version: "1", scope: "slot", ownerId: "B", dependencies: [] }, adapter), /OWNER_MISMATCH/); checks++;
    assert.throws(() => services.register({ serviceId: "cycle", version: "1", scope: "slot", ownerId: "A", dependencies: ["cycle"] }, adapter), /DEPENDENCIES/); checks++;
    await services.setDesired("test-child", { state: "running", manualHold: false }, 1);
    await services.reconcile("test-child");
    check(starts === 1 && services.describe("test-child").observation.state === "running", "reconcile actually starts owned test process");
    await Promise.all([services.reconcile("test-child"), services.reconcile("test-child")]);
    check(starts === 1, "concurrent reconciliation never duplicates running process");
    await services.setDesired("test-child", { state: "running", manualHold: true }, 2);
    await services.reconcile("test-child");
    await services.reconcile("test-child");
    check(starts === 1 && stops === 1 && services.describe("test-child").observation.state === "stopped", "manual hold stops and prevents automatic restart despite desired running");
    await assert.rejects(services.setDesired("test-child", { state: "running", manualHold: false }, 2), /STALE_SERVICE_REVISION/); checks++;
    a2.close();
    const a3 = await CoreRuntime.start({ stateDir, slotId: "A", workspaceRoots, verifyProtection: testProtection });
    cores.push(a3);
    const restored = new ManagedServiceController(a3.state, { scope: "slot", ownerId: "A" }, { now: () => now, random: () => 0 });
    restored.register({ serviceId: "test-child", version: "1", scope: "slot", ownerId: "A", dependencies: [] }, adapter);
    await restored.reconcile("test-child");
    check(restored.describe("test-child").desired.manualHold && starts === 1, "manual hold survives Core restart");
    await restored.setDesired("test-child", { state: "running", manualHold: false }, 3);
    await restored.reconcile("test-child");
    check(starts === 2, "explicit release resumes service");
    for (let crash = 0; crash < 3; crash++) {
      await killOwned(serviceProcess!);
      await restored.reconcile("test-child");
      now += 10_000;
      await restored.reconcile("test-child");
    }
    check(restored.describe("test-child").diagnostic === "CRASH_LOOP" && starts === 4, "service crash budget survives reconciliation and stops restart loop");

    let unknownStarts = 0;
    restored.register({ serviceId: "unknown", version: "1", scope: "slot", ownerId: "A", dependencies: [] }, {
      observe: async () => ({ state: "unknown", healthy: false }), start: async () => { unknownStarts++; }, stop: async () => undefined,
    });
    await restored.setDesired("unknown", { state: "running", manualHold: false }, 1);
    await restored.reconcile("unknown");
    check(unknownStarts === 0, "unknown process outcome never triggers duplicate start");
    let dependentStarts = 0;
    restored.register({ serviceId: "dependent", version: "1", scope: "slot", ownerId: "A", dependencies: ["unknown"] }, {
      observe: async () => ({ state: "stopped", healthy: false }), start: async () => { dependentStarts++; }, stop: async () => undefined,
    });
    await restored.setDesired("dependent", { state: "running", manualHold: false }, 1);
    await restored.reconcile("dependent");
    check(dependentStarts === 0 && restored.describe("dependent").diagnostic === "WAITING_DEPENDENCY", "unhealthy dependency blocks child service start");
    const changedDefinition = new ManagedServiceController(a3.state, { scope: "slot", ownerId: "A" });
    assert.throws(() => changedDefinition.register({ serviceId: "test-child", version: "2", scope: "slot", ownerId: "A", dependencies: [] }, adapter), /DEFINITION_CHANGED/); checks++;
    console.log(`V3 Core: ${checks} checks passed`);
  } finally {
    for (const child of children) await killOwned(child);
    for (const core of cores) core.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
