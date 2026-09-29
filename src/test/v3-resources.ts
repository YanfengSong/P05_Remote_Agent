import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceCoordinator, ResourceError, type LeaseOwner, type ResourceDescriptor, type RecoveryEvidence, type ResourceLease } from "../v3/resources/index.js";

if (process.argv[2] === "--coordinator-child") {
  try {
    const coordinator = ResourceCoordinator.open({ stateDir: process.argv[3], hostId: "host-test" });
    let crashLease: ResourceLease | undefined;
    if (process.argv[4] === "crash-owner") {
      coordinator.registerResource({ resourceId: "crash-resource", kind: "test-resource", stablePhysicalIdentity: "test:crash-resource", mode: "exclusive-session", capacity: 1, adapter: "test-broker" });
      crashLease = coordinator.acquire({ owner: { slotId: "A", runId: "child-run", executorId: "child-executor", executorBootId: "child-boot" }, resourceIds: ["crash-resource"], ttlMs: 60_000 }).leases[0];
    }
    process.send?.({ ok: true, lease: crashLease });
    if (process.argv[4] === "exit") { coordinator.close(); process.disconnect?.(); }
    else setInterval(() => undefined, 1_000);
  } catch (error) { process.send?.({ ok: false, code: error instanceof ResourceError ? error.code : "ERROR" }); process.disconnect?.(); }
} else {
  const directory = mkdtempSync(path.join(os.tmpdir(), "p05-v3-resources-"));
  const stateDir = path.join(directory, "resources");
  const children: ChildProcess[] = [];
  const coordinators: ResourceCoordinator[] = [];
  let now = 10_000;
  let checks = 0;
  let recoveryVerified = false;
  const a: LeaseOwner = { slotId: "A", runId: "run-a", executorId: "worker-a", executorBootId: "boot-a" };
  const b: LeaseOwner = { slotId: "B", runId: "run-b", executorId: "worker-b", executorBootId: "boot-b" };
  const c: LeaseOwner = { slotId: "C", runId: "run-c", executorId: "worker-c", executorBootId: "boot-c" };
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
  const errorCode = (code: string) => (error: unknown) => error instanceof ResourceError && error.code === code;
  const descriptor = (resourceId: string, mode: ResourceDescriptor["mode"] = "exclusive-session", capacity = 1): ResourceDescriptor => ({ resourceId, kind: "test-resource", stablePhysicalIdentity: `test-only:${resourceId}`, mode, capacity, adapter: "test-broker" });
  const evidence = (lease: ResourceLease): RecoveryEvidence => ({ kind: "executor-terminated", executorId: lease.owner.executorId, executorBootId: lease.owner.executorBootId, evidenceRef: "test-proof" });
  const open = () => {
    const coordinator = ResourceCoordinator.open({ stateDir, hostId: "host-test", now: () => now, maxQueue: 2, verifyTermination: async () => recoveryVerified });
    coordinators.push(coordinator); return coordinator;
  };
  async function childOpen(childStateDir = stateDir, mode = "exit") {
    const child = fork(fileURLToPath(import.meta.url), ["--coordinator-child", childStateDir, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    const result = await new Promise<{ ok: boolean; code?: string; lease?: ResourceLease }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CHILD_TIMEOUT")), 10_000);
      child.once("message", (value) => { clearTimeout(timeout); resolve(value as { ok: boolean }); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("CHILD_EXITED_EARLY")); });
    });
    return { ...result, child };
  }
  try {
    let coordinator = open();
    coordinator.registerResource(descriptor("matlab-test"));
    coordinator.registerResource(descriptor("serial-test", "serialized-operation"));
    coordinator.registerResource(descriptor("shared-test", "shared", 2));
    coordinator.registerResource(descriptor("free-test"));
    coordinator.registerResource(descriptor("other-test"));
    assert.throws(() => ResourceCoordinator.open({ stateDir, hostId: "host-test" }), errorCode("COORDINATOR_ALREADY_OWNED")); checks++;
    const contender = await childOpen();
    check(!contender.ok && contender.code === "COORDINATOR_ALREADY_OWNED", "OS lock rejects second Coordinator process");
    assert.throws(() => coordinator.registerResource({ ...descriptor("alias"), stablePhysicalIdentity: "test-only:matlab-test" }), errorCode("DUPLICATE_PHYSICAL_RESOURCE")); checks++;
    assert.throws(() => coordinator.registerResource(descriptor("invalid", "exclusive-session", 2)), errorCode("INVALID_RESOURCE_DESCRIPTOR")); checks++;

    const first = coordinator.acquire({ requestId: "first", owner: a, resourceIds: ["matlab-test"], ttlMs: 1_000 });
    check(first.state === "GRANTED" && first.leases.length === 1, "Slot A acquires exclusive session");
    const aLease = first.leases[0];
    assert.throws(() => coordinator.acquire({ owner: a, resourceIds: ["free-test"], ttlMs: 1_000, waitMs: 1_000 }), errorCode("RESOURCE_HOLD_AND_WAIT_FORBIDDEN")); checks++;
    check(coordinator.acquire({ owner: b, resourceIds: ["matlab-test"], ttlMs: 1_000 }).state === "BUSY", "Slot B cannot steal A resource");
    check(coordinator.acquire({ requestId: "first", owner: a, resourceIds: ["matlab-test"], ttlMs: 1_000 }).leases[0].leaseId === aLease.leaseId, "request replay finds same grant");
    assert.throws(() => coordinator.acquire({ requestId: "first", owner: a, resourceIds: ["serial-test"], ttlMs: 1_000 }), errorCode("RESOURCE_IDEMPOTENCY_CONFLICT")); checks++;
    assert.throws(() => coordinator.queryRequest("first", b), errorCode("REQUEST_NOT_FOUND_OR_NOT_OWNED")); checks++;
    assert.throws(() => coordinator.queryLease(aLease, b), errorCode("INVALID_LEASE_CREDENTIAL")); checks++;
    assert.throws(() => coordinator.renew({ ...aLease, token: "0".repeat(64) }, a, 1_000), errorCode("INVALID_LEASE_CREDENTIAL")); checks++;
    assert.throws(() => coordinator.release({ ...aLease, fencingEpoch: aLease.fencingEpoch + 1 }, a), errorCode("INVALID_LEASE_CREDENTIAL")); checks++;
    check(coordinator.validateToken("matlab-test", aLease, a).state === "ACTIVE", "adapter validates exact owner and fencing credential");
    assert.throws(() => coordinator.validateToken("serial-test", aLease, a), errorCode("RESOURCE_LEASE_MISMATCH")); checks++;
    check(!JSON.stringify(coordinator.inspect("matlab-test")).includes(aLease.token), "maintenance diagnostics omit lease token");
    check(!coordinator.inspect("matlab-test").osIsolationEnforced, "coordination never claims OS enforcement");

    const waiting = coordinator.acquire({ requestId: "waiting-b", owner: b, resourceIds: ["matlab-test"], ttlMs: 1_000, waitMs: 2_000 });
    check(waiting.state === "WAITING" && waiting.leases.length === 0, "queued Slot B holds no resource");
    const atomicWait = coordinator.acquire({ requestId: "atomic-wait", owner: c, resourceIds: ["free-test", "matlab-test"], ttlMs: 1_000, waitMs: 2_000 });
    check(atomicWait.state === "WAITING" && coordinator.inspect("free-test").holders.length === 0, "multi-resource wait reserves nothing partially");
    assert.throws(() => coordinator.acquire({ owner: c, resourceIds: ["other-test"], ttlMs: 1_000, waitMs: 2_000 }), errorCode("RESOURCE_QUEUE_FULL")); checks++;
    check(coordinator.cancelWait("atomic-wait", c).state === "CANCELLED", "waiting cancellation persists");
    coordinator.release(aLease, a);
    check(coordinator.pumpQueue().includes("waiting-b"), "release then queue pump grants next Slot");
    const bLease = coordinator.queryRequest("waiting-b", b).leases[0];
    check(bLease.fencingEpoch > aLease.fencingEpoch, "handover strictly increments fencing epoch");
    assert.throws(() => coordinator.validateToken("matlab-test", aLease, a), errorCode("LEASE_NOT_ACTIVE")); checks++;
    assert.throws(() => coordinator.cancelWait("waiting-b", b), errorCode("REQUEST_ALREADY_GRANTED_RELEASE_LEASES")); checks++;
    check(coordinator.release(aLease, a).state === "RELEASED", "repeat old release is idempotent and cannot affect new holder");
    check(coordinator.inspect("matlab-test").holders[0].leaseId === bLease.leaseId, "old release did not evict B");

    now += 900;
    const renewed = coordinator.renew(bLease, b, 1_000);
    check(renewed.expiresAt === now + 1_000, "renew preserves epoch and extends expiry");
    now += 1_001;
    check(coordinator.queryLease(bLease, b).state === "QUARANTINED", "expired lease becomes quarantined");
    check(coordinator.acquire({ owner: a, resourceIds: ["matlab-test"], ttlMs: 1_000 }).state === "BUSY", "TTL expiry cannot grant exclusive resource to another owner");
    assert.throws(() => coordinator.release(bLease, b), errorCode("LEASE_NOT_ACTIVE")); checks++;
    await assert.rejects(coordinator.reconcileLease(bLease.leaseId, bLease.fencingEpoch, evidence(bLease)), errorCode("RESOURCE_RECOVERY_NOT_VERIFIED")); checks++;
    recoveryVerified = true;
    await assert.rejects(coordinator.reconcileLease(bLease.leaseId, bLease.fencingEpoch, { ...evidence(bLease), executorBootId: "wrong-boot" }), errorCode("INVALID_RESOURCE_RECOVERY_EVIDENCE")); checks++;
    await coordinator.reconcileLease(bLease.leaseId, bLease.fencingEpoch, evidence(bLease));
    const afterRecovery = coordinator.acquire({ owner: a, resourceIds: ["matlab-test"], ttlMs: 1_000 });
    check(afterRecovery.state === "GRANTED" && afterRecovery.leases[0].fencingEpoch > bLease.fencingEpoch, "verified recovery releases uncertainty without resetting epoch");
    coordinator.release(afterRecovery.leases[0], a);

    const sharedA = coordinator.acquire({ owner: a, resourceIds: ["shared-test"], ttlMs: 1_000 }).leases[0];
    const sharedB = coordinator.acquire({ owner: b, resourceIds: ["shared-test"], ttlMs: 1_000 }).leases[0];
    check(sharedA.fencingEpoch < sharedB.fencingEpoch && coordinator.validateToken("shared-test", sharedA, a).state === "ACTIVE", "new shared epoch does not invalidate another active shared lease");
    check(coordinator.acquire({ owner: c, resourceIds: ["shared-test"], ttlMs: 1_000 }).state === "BUSY", "shared capacity is enforced");
    coordinator.release(sharedA, a);
    const sharedC = coordinator.acquire({ owner: c, resourceIds: ["shared-test"], ttlMs: 1_000 }).leases[0];
    check(!!sharedC && sharedC.fencingEpoch > sharedB.fencingEpoch, "released shared capacity permits next fenced holder");

    const serial = coordinator.acquire({ owner: a, resourceIds: ["serial-test"], ttlMs: 1_000 }).leases[0];
    const atomicFail = coordinator.acquire({ owner: b, resourceIds: ["free-test", "serial-test"], ttlMs: 1_000 });
    check(atomicFail.state === "BUSY" && coordinator.inspect("free-test").holders.length === 0, "atomic acquire failure leaves all other resources free");
    coordinator.release(serial, a);
    const multi = coordinator.acquire({ owner: b, resourceIds: ["serial-test", "free-test"], ttlMs: 1_000 });
    check(multi.state === "GRANTED" && multi.leases.length === 2 && multi.resourceIds.join(",") === "free-test,serial-test", "multi-resource success grants a stable ordered bundle");

    const waitingOwner = { ...c, runId: "run-c-waiting" };
    const expiresWait = coordinator.acquire({ requestId: "expires-wait", owner: waitingOwner, resourceIds: ["serial-test"], ttlMs: 1_000, waitMs: 100 });
    now += 101;
    coordinator.pumpQueue();
    check(coordinator.queryRequest(expiresWait.requestId, waitingOwner).state === "EXPIRED", "bounded wait expires without acquiring resources");
    const epochBeforeRestart = coordinator.inspect("shared-test").fencingEpoch;
    coordinator.close();
    coordinator = open();
    check(coordinator.inspect("shared-test").state === "QUARANTINED" && coordinator.inspect("shared-test").holders.every((lease) => lease.state === "QUARANTINED"), "Coordinator reopen preserves and quarantines unknown active owners");
    check(coordinator.inspect("shared-test").fencingEpoch === epochBeforeRestart, "restart never resets fencing epoch");
    assert.throws(() => coordinator.validateToken("shared-test", sharedB, b), errorCode("LEASE_NOT_ACTIVE")); checks++;
    await coordinator.reconcileLease(sharedB.leaseId, sharedB.fencingEpoch, evidence(sharedB));
    check(coordinator.inspect("shared-test").state === "QUARANTINED", "recovering one shared holder leaves other uncertainty isolated");
    await coordinator.reconcileLease(sharedC.leaseId, sharedC.fencingEpoch, evidence(sharedC));
    check(coordinator.inspect("shared-test").state === "AVAILABLE", "all uncertain shared holders must reconcile before reuse");
    for (const lease of multi.leases) await coordinator.reconcileLease(lease.leaseId, lease.fencingEpoch, evidence(lease));
    const reopenedGrant = coordinator.acquire({ owner: a, resourceIds: ["serial-test"], ttlMs: 1_000 });
    check(reopenedGrant.leases[0].fencingEpoch > multi.leases.find((lease) => lease.resourceId === "serial-test")!.fencingEpoch, "persistent epochs increase after reopen and verified handover");
    coordinator.quarantine("serial-test", "TEST_UNCERTAIN_ADAPTER");
    check(coordinator.inspect("serial-test").state === "QUARANTINED", "trusted broker can explicitly quarantine an uncertain operation");

    coordinator.close();
    assert.throws(() => ResourceCoordinator.open({ stateDir, hostId: "other-host" }), errorCode("RESOURCE_HOST_MISMATCH")); checks++;
    coordinator = open();
    check(coordinator.inspect("serial-test").state === "QUARANTINED", "failed identity open releases coordinator lock and preserves quarantine");
    const noVerifier = ResourceCoordinator.open({ stateDir: path.join(directory, "no-verifier"), hostId: "other-host", now: () => now });
    coordinators.push(noVerifier);
    noVerifier.registerResource(descriptor("device"));
    const noProofLease = noVerifier.acquire({ owner: a, resourceIds: ["device"], ttlMs: 1 }).leases[0];
    now += 2;
    await assert.rejects(noVerifier.reconcileLease(noProofLease.leaseId, noProofLease.fencingEpoch, evidence(noProofLease)), errorCode("RECOVERY_VERIFIER_UNAVAILABLE")); checks++;
    const crashStateDir = path.join(directory, "crash-owner");
    const crashed = await childOpen(crashStateDir, "crash-owner");
    check(crashed.ok && crashed.lease?.state === "ACTIVE", "independent Coordinator process owns a persisted resource");
    const crashedExit = once(crashed.child, "exit");
    crashed.child.kill("SIGKILL");
    await crashedExit;
    const afterCrash = ResourceCoordinator.open({ stateDir: crashStateDir, hostId: "host-test" });
    coordinators.push(afterCrash);
    check(afterCrash.inspect("crash-resource").state === "QUARANTINED" && afterCrash.inspect("crash-resource").holders[0].leaseId === crashed.lease!.leaseId, "OS lock releases after real crash but old resource owner remains quarantined");
    check(afterCrash.acquire({ owner: b, resourceIds: ["crash-resource"], ttlMs: 1_000 }).state === "BUSY", "Coordinator process death is not evidence its external executor stopped");
    console.log(`V3 resources: ${checks} checks passed`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    }
    for (const coordinator of coordinators) coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
