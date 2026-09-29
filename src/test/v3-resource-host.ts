import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcClient, type RpcClient } from "../v3/transport/rpc.js";
import type { ResourceRequest } from "../v3/resources/types.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";

type Ready = { event: string; hostId: string; endpoints: { slotId: string; principalId: string; endpoint: string; clientTokenFile: string }[]; operatorTokenFile: string };
const children: ChildProcess[] = [];
const fixtures: Awaited<ReturnType<typeof createPrivateV3Fixture>>[] = [];
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const entrypoint = fileURLToPath(new URL("../v3-resource-host.js", import.meta.url));

async function launch(filename: string) {
  const child = spawn(process.execPath, [entrypoint], { env: { ...process.env, P05_V3_RESOURCE_CONFIG: filename }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RESOURCE_HOST_START_TIMEOUT")), 30_000);
    let text = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 64 * 1024) { clearTimeout(timer); reject(new Error("RESOURCE_HOST_DIAGNOSTIC_LIMIT")); return; }
      for (;;) {
        const newline = text.indexOf("\n"); if (newline < 0) break;
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        try {
          const message = JSON.parse(line) as Ready & { code?: string };
          if (message.event === "p05.v3.resource.ready") { clearTimeout(timer); resolve(message); }
          if (message.event === "p05.v3.resource.start_failed") { clearTimeout(timer); reject(new Error(message.code)); }
        } catch (error) { if (error instanceof SyntaxError) continue; clearTimeout(timer); reject(error); }
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("RESOURCE_HOST_EXITED")); });
  });
  return { child, ready };
}

async function killOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
async function call<T = Record<string, unknown>>(client: RpcClient, method: string, input: unknown): Promise<T> {
  const result = await client.call(method, input) as { error?: { code: string } };
  if (result.error) throw new Error(result.error.code);
  return result as T;
}
async function clients(ready: Ready) {
  const operatorToken = (await fs.readFile(ready.operatorTokenFile, "utf8")).trim();
  const a = ready.endpoints.find((endpoint) => endpoint.slotId === "A")!;
  const b = ready.endpoints.find((endpoint) => endpoint.slotId === "B")!;
  const aToken = (await fs.readFile(a.clientTokenFile, "utf8")).trim();
  const bToken = (await fs.readFile(b.clientTokenFile, "utf8")).trim();
  return {
    a: createRpcClient({ url: a.endpoint, token: aToken }), b: createRpcClient({ url: b.endpoint, token: bToken }),
    ao: createRpcClient({ url: a.endpoint, token: operatorToken }), bo: createRpcClient({ url: b.endpoint, token: operatorToken }),
    wrongListener: createRpcClient({ url: a.endpoint, token: bToken }),
  };
}

try {
  const fixture = await createPrivateV3Fixture(); fixtures.push(fixture);
  const stateDir = path.join(fixture.state, "resource-store"); await fs.mkdir(stateDir, { mode: 0o700 });
  const secondWorkspace = path.join(fixture.root, "workspace-b"); await fs.mkdir(secondWorkspace);
  const config = { version: 1, hostId: "test-host", stateDir, slots: [
    { slotId: "A", principalId: "principal-a", workspaceRoot: fixture.workspace },
    { slotId: "B", principalId: "principal-b", workspaceRoot: secondWorkspace },
  ] };
  const filename = path.join(fixture.state, "resource-config.json"); await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  let host = await launch(filename); let rpc = await clients(host.ready);
  await assert.rejects(launch(filename), /COORDINATOR_ALREADY_OWNED/); checks++;
  const statusA = await call(rpc.a, "resource_status", {}); const statusB = await call(rpc.b, "resource_status", {});
  check(statusA.hostId === statusB.hostId && statusA.slotId === "A" && statusB.slotId === "B" && statusA.principalId === "principal-a" && statusB.principalId === "principal-b", "separate authenticated listeners bind fixed Slot and principal to one Host");
  check(statusA.sharedCoordinator && !statusA.isolationEnforced && !statusA.recoveryVerifierAvailable, "status reports shared coordinator and real enforcement limits");
  await assert.rejects(call(rpc.wrongListener, "resource_status", {}), /UNAUTHORIZED/); checks++;
  const register = (resourceId: string) => ({ resourceId, kind: "test", stablePhysicalIdentity: `test:${resourceId}`, mode: "exclusive-session", capacity: 1, adapter: "test" });
  await assert.rejects(call(rpc.a, "resource_register", register("device")), /OPERATOR_REQUIRED/); checks++;
  await call(rpc.ao, "resource_register", register("device"));
  await call(rpc.ao, "resource_register", register("crash-device"));
  check((await call(rpc.bo, "resource_inspect", { resourceId: "device" })).resourceId === "device", "Slot B operator sees resource registered through Slot A listener");
  const ctxA = { contextId: "ctx-a", runId: "run-a", executorId: "executor-a", executorBootId: "boot-a", resourceIds: ["device", "crash-device"], expiresAt: Date.now() + 120_000, maxLeaseMs: 30_000 };
  const ctxB = { ...ctxA, contextId: "ctx-b", runId: "run-b", executorId: "executor-b", executorBootId: "boot-b" };
  await assert.rejects(call(rpc.a, "resource_context_register", ctxA), /OPERATOR_REQUIRED/); checks++;
  await call(rpc.ao, "resource_context_register", ctxA); await call(rpc.bo, "resource_context_register", ctxB);
  await assert.rejects(call(rpc.ao, "resource_context_register", { ...ctxA, contextId: "alias-run-context" }), /RUN_CONTEXT_ALREADY_BOUND/); checks++;
  await assert.rejects(call(rpc.a, "resource_acquire", { contextId: "unknown", resourceIds: ["device"], ttlMs: 1_000, idempotencyKey: "unknown" }), /CONTEXT_NOT_FOUND/); checks++;
  await assert.rejects(call(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["device"], ttlMs: 1_000, idempotencyKey: "spoof", owner: { slotId: "B" } }), /INVALID_RESOURCE_ARGUMENT/); checks++;
  await assert.rejects(call(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["not-granted"], ttlMs: 1_000, idempotencyKey: "scope" }), /SCOPE_EXCEEDED/); checks++;
  await assert.rejects(call(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["device"], ttlMs: 40_000, idempotencyKey: "duration" }), /SCOPE_EXCEEDED/); checks++;
  const first = await call<ResourceRequest>(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["device"], ttlMs: 10_000, idempotencyKey: "first" });
  const credential = { leaseId: first.leases[0].leaseId, token: first.leases[0].token, fencingEpoch: first.leases[0].fencingEpoch };
  check(first.state === "GRANTED" && first.leases[0].owner.slotId === "A", "Host maps authenticated Slot A run context into actual lease owner");
  await assert.rejects(call(rpc.b, "resource_release", { contextId: ctxB.contextId, credential }), /INVALID_LEASE_CREDENTIAL/); checks++;
  await assert.rejects(call(rpc.b, "resource_lease", { contextId: ctxB.contextId, credential }), /INVALID_LEASE_CREDENTIAL/); checks++;
  await assert.rejects(call(rpc.b, "resource_request", { contextId: ctxB.contextId, requestId: first.requestId }), /REQUEST_CONTEXT_MISMATCH/); checks++;
  const duplicate = await call<ResourceRequest>(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["device"], ttlMs: 10_000, idempotencyKey: "first" });
  check(duplicate.leases[0].leaseId === first.leases[0].leaseId, "RPC idempotency remains bound to captured run context");
  const wait = await call<ResourceRequest>(rpc.b, "resource_acquire", { contextId: ctxB.contextId, resourceIds: ["device"], ttlMs: 10_000, waitMs: 10_000, idempotencyKey: "waiting" });
  check(wait.state === "WAITING", "Slot B queues against Slot A in independent ResourceHost process");
  await call(rpc.a, "resource_release", { contextId: ctxA.contextId, credential });
  const bLease = (await call<ResourceRequest>(rpc.b, "resource_request", { contextId: ctxB.contextId, requestId: wait.requestId })).leases[0];
  const bCredential = { leaseId: bLease.leaseId, token: bLease.token, fencingEpoch: bLease.fencingEpoch };
  check(bLease.owner.slotId === "B" && bLease.fencingEpoch > credential.fencingEpoch, "shared Host pump grants B with a newer epoch");
  await assert.rejects(call(rpc.a, "resource_validate", { contextId: ctxA.contextId, resourceId: "device", credential }), /LEASE_NOT_ACTIVE/); checks++;
  await call(rpc.b, "resource_release", { contextId: ctxB.contextId, credential: bCredential });

  const expiring = await call<ResourceRequest>(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["device"], ttlMs: 100, idempotencyKey: "expiring" });
  await delay(300);
  check((await call(rpc.ao, "resource_inspect", { resourceId: "device" })).state === "QUARANTINED", "live Host expiry quarantines rather than reassigns");
  await assert.rejects(call(rpc.a, "resource_reconcile", {}), /OPERATOR_REQUIRED/); checks++;
  await assert.rejects(call(rpc.ao, "resource_reconcile", { leaseId: expiring.leases[0].leaseId, terminated: true }), /RECOVERY_VERIFIER_UNAVAILABLE/); checks++;
  check((await call(rpc.ao, "resource_inspect", { resourceId: "device" })).state === "QUARANTINED", "caller termination assertion cannot bypass real recovery verification");

  const beforeCrash = await call<ResourceRequest>(rpc.a, "resource_acquire", { contextId: ctxA.contextId, resourceIds: ["crash-device"], ttlMs: 30_000, idempotencyKey: "crash-active" });
  const oldCredential = { leaseId: beforeCrash.leases[0].leaseId, token: beforeCrash.leases[0].token, fencingEpoch: beforeCrash.leases[0].fencingEpoch };
  await killOwned(host.child); host = await launch(filename); rpc = await clients(host.ready);
  check((await call(rpc.ao, "resource_inspect", { resourceId: "crash-device" })).state === "QUARANTINED", "real ResourceHost SIGKILL preserves and isolates unknown old owner");
  check((await call(rpc.a, "resource_lease", { contextId: ctxA.contextId, credential: oldCredential })).state === "QUARANTINED", "private context binding and lease survive Host process restart");
  check((await call<ResourceRequest>(rpc.b, "resource_acquire", { contextId: ctxB.contextId, resourceIds: ["crash-device"], ttlMs: 1_000, idempotencyKey: "after-crash" })).state === "BUSY", "Slot B cannot steal isolated resource after restart");
  const revokeWait = await call<ResourceRequest>(rpc.b, "resource_acquire", { contextId: ctxB.contextId, resourceIds: ["crash-device"], ttlMs: 1_000, waitMs: 10_000, idempotencyKey: "revoke-wait" });
  await call(rpc.bo, "resource_context_revoke", { contextId: ctxB.contextId });
  check((await call<ResourceRequest>(rpc.b, "resource_request", { contextId: ctxB.contextId, requestId: revokeWait.requestId })).state === "CANCELLED", "context revocation durably cancels queued acquisition");
  await assert.rejects(call(rpc.b, "resource_acquire", { contextId: ctxB.contextId, resourceIds: ["device"], ttlMs: 1_000, idempotencyKey: "revoked" }), /CONTEXT_INACTIVE/); checks++;
  await killOwned(host.child);

  const unprotected = await createPrivateV3Fixture(true); fixtures.push(unprotected);
  const badStore = path.join(unprotected.state, "resource-store"); await fs.mkdir(badStore, { mode: 0o700 });
  const badFile = path.join(unprotected.state, "resource-config.json");
  await fs.writeFile(badFile, JSON.stringify({ ...config, stateDir: badStore, slots: [{ slotId: "A", principalId: "principal-a", workspaceRoot: unprotected.workspace }] }), { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(unprotected.state, 0o755);
  await assert.rejects(launch(badFile), /PROTECTION_UNVERIFIED/); checks++;
  console.log(`V3 ResourceHost: ${checks} checks passed`);
} finally {
  for (const child of children) await killOwned(child);
  for (const fixture of fixtures) await fixture.remove();
}
