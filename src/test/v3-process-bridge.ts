import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { createProcessBridge, validateProcessInput } from "../v3/process-bridge.js";
import { DurableStore } from "../v3/durable/store.js";
import { createDurableKernel } from "../v3/durable/kernel.js";
import { DurableError, ExecutionDetached, UnconfirmedOutcome, type ExecutionContext, type Json, type Run } from "../v3/durable/types.js";
import { createRpcClient, startRpcServer } from "../v3/transport/rpc.js";

const fixture = await createPrivateV3Fixture();
const hostState = path.join(fixture.state, "executor");
const configDir = path.join(fixture.state, "configuration");
fs.mkdirSync(hostState, { mode: 0o700 });
fs.mkdirSync(configDir, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
const tokenFile = path.join(configDir, "executor-token");
const operatorTokenFile = path.join(configDir, "executor-operator-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
fs.writeFileSync(operatorTokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const configFile = path.join(configDir, "executor.json");
fs.writeFileSync(configFile, JSON.stringify({ stateDir: hostState, workspaceRoot: fixture.workspace, slot: "B", principal: "bridge-owner", securityMode: "trusted-host", clientTokenFile: tokenFile, operatorTokenFile }), { mode: 0o600 });
const hostEntry = fileURLToPath(new URL("../v3-process-host.js", import.meta.url));
assert.ok(fs.existsSync(hostEntry), "compile the actual Process Host before testing the bridge");
const child = spawn(process.execPath, [hostEntry], { env: { ...process.env, P05_V3_PROCESS_CONFIG: configFile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout?.resume(); child.stderr?.resume();
const context: ExecutionContext = { hostId: "bridge-host", slotId: "B", principal: "bridge-owner", workspaceId: "test-workspace", workspaceRoot: fs.realpathSync(fixture.workspace), authorizationRevision: "1" };
const owner = { slotId: context.slotId, principal: context.principal };
const kernels: ReturnType<typeof createDurableKernel>[] = [];
let coreRpc: Awaited<ReturnType<typeof startRpcServer>> | undefined;
let orphanDeadline = 0;

async function stopHost(target: ChildProcess) {
  if (target.exitCode !== null || target.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
  target.kill("SIGKILL"); await exited;
}
async function waitState(kernel: ReturnType<typeof createDurableKernel>["kernel"], id: string, states: string[]): Promise<Run> {
  for (let index = 0; index < 400; index += 1) {
    const run = kernel.status(owner, id);
    if (states.includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Bridge Run state deadline exceeded");
}

try {
  let endpoint = "";
  for (let index = 0; index < 1000; index += 1) {
    if (child.exitCode !== null) throw new Error("External Process Host failed to start");
    try { endpoint = (JSON.parse(fs.readFileSync(path.join(hostState, "endpoint.json"), "utf8")) as { url: string }).url; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(endpoint);
  const connectionFile = path.join(configDir, "connection.json");
  fs.writeFileSync(connectionFile, JSON.stringify({ version: 1, url: endpoint, clientTokenFile: tokenFile, slot: "B", principal: "bridge-owner", workspaceRoot: fixture.workspace, securityMode: "trusted-host" }), { mode: 0o600 });
  const bridgeOptions = { connectionFile, slotId: "B", principal: "bridge-owner", workspaceRoot: fixture.workspace, pollIntervalMs: 20, rpcTimeoutMs: 1000, summaryBytes: 64 };
  const alias = path.join(fixture.state, "workspace-alias");
  fs.symlinkSync(fixture.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    fs.copyFileSync(connectionFile, path.join(fixture.workspace, "exposed-connection.json"));
    await assert.rejects(createProcessBridge({ ...bridgeOptions, connectionFile: path.join(alias, "exposed-connection.json") }),
      (error: unknown) => error instanceof DurableError && error.code === "PROCESS_CONNECTION_IN_WORKSPACE");
    fs.writeFileSync(path.join(fixture.workspace, "exposed-token"), token, { mode: 0o600 });
    const exposedConfig = path.join(configDir, "aliased-token-connection.json");
    fs.writeFileSync(exposedConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(connectionFile, "utf8")), clientTokenFile: path.join(alias, "exposed-token") }), { mode: 0o600 });
    await assert.rejects(createProcessBridge({ ...bridgeOptions, connectionFile: exposedConfig }),
      (error: unknown) => error instanceof DurableError && error.code === "PROCESS_CREDENTIAL_UNPROTECTED");
  } finally { fs.unlinkSync(alias); }
  const bridge = await createProcessBridge(bridgeOptions);
  const binding = bridge.capabilities[0]!;
  assert.equal(bridge.metadata[0].effect, "E4");
  assert.throws(() => validateProcessInput("process_run", { executable: process.execPath, args: [], owner: { slot: "A" } }), /Unrecognized key/);
  await assert.rejects(createProcessBridge({ ...bridgeOptions, principal: "someone-else" }), /identity does not match/);
  const pair = createDurableKernel({
    store: new DurableStore(path.join(fixture.state, "core.sqlite")),
    authorize: () => ({ decision: "CONFIRM", reason: "Explicit arbitrary process approval", expiresAt: Date.now() + 60000 }),
    revalidate: (run) => run.context.principal === context.principal && run.context.workspaceRoot === context.workspaceRoot
  });
  kernels.push(pair); pair.kernel.register(binding);
  const marker = path.join(fixture.workspace, "approved-once.txt");
  const input: Json = { executable: process.execPath, args: ["-e", `setTimeout(()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');console.log('a'.repeat(200)+'-tail');},500)`] };
  const first = pair.kernel.submit(context, { capability: "process_run", input, idempotencyKey: "approved-once" });
  const pending = await waitState(pair.kernel, first.executionId, ["WAITING_APPROVAL"]);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(pair.kernel.submit(context, { capability: "process_run", input, idempotencyKey: "approved-once" }).executionId, first.executionId);
  pair.operator.decide({ approvalId: pending.approval!.approvalId, expectedDecisionVersion: pending.approval!.decisionVersion, decision: "APPROVE", actor: "local-operator" });
  await waitState(pair.kernel, first.executionId, ["RUNNING"]);

  const coreToken = randomBytes(32).toString("hex");
  coreRpc = await startRpcServer({ clientToken: coreToken, operatorToken: randomBytes(32).toString("hex"), async handle(method) {
    assert.equal(method, "observe");
    return pair.kernel.wait(owner, first.executionId, pair.kernel.status(owner, first.executionId).stateVersion, 300);
  } });
  const waitingClient = createRpcClient({ url: coreRpc.url, token: coreToken, timeoutMs: 30 });
  await assert.rejects(waitingClient.call("observe", {}), /WAIT_TIMEOUT/);
  const done = await waitState(pair.kernel, first.executionId, ["SUCCEEDED", "FAILED", "UNKNOWN"]);
  assert.equal(done.state, "SUCCEEDED", JSON.stringify(done.result));
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  const result = done.result as { processId: string; stdout: { text: string; nextOffset: number }; truncated: boolean };
  assert.equal(result.stdout.text.length, 64);
  assert.equal(result.truncated, true);
  const output = await bridge.outputForRun(done, { offset: result.stdout.nextOffset, limit: 1024 });
  assert.match(Buffer.from(output.dataBase64, "base64").toString("utf8"), /-tail/);
  assert.equal((await bridge.statusForRun(done)).id, result.processId);
  assert.equal(pair.kernel.submit(context, { capability: "process_run", input, idempotencyKey: "approved-once" }).executionId, first.executionId);
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  const neverDispatched = { ...done, executionId: randomUUID() };
  const alreadyDetached = new AbortController();
  alreadyDetached.abort(new ExecutionDetached());
  await assert.rejects(binding.execute({ run: neverDispatched, input, signal: alreadyDetached.signal }),
    (error: unknown) => error instanceof UnconfirmedOutcome && error.code === "PROCESS_CORE_DETACHED");
  const executorClient = createRpcClient({ url: endpoint, token });
  assert.deepEqual(await executorClient.call("process_lookup", { dispatchKey: `${neverDispatched.executionId}:attempt1`, owner: { slot: "B", principal: "bridge-owner", runId: neverDispatched.executionId, attemptId: `${neverDispatched.executionId}:attempt1` } }), { error: { code: "PROCESS_NOT_FOUND" } });

  const fail = pair.kernel.submit(context, { capability: "process_run", input: { executable: process.execPath, args: ["-e", "console.error('known-exit');process.exit(7)"] }, idempotencyKey: "known-failure" });
  const failPending = await waitState(pair.kernel, fail.executionId, ["WAITING_APPROVAL"]);
  pair.operator.decide({ approvalId: failPending.approval!.approvalId, expectedDecisionVersion: failPending.approval!.decisionVersion, decision: "APPROVE", actor: "local-operator" });
  const failed = await waitState(pair.kernel, fail.executionId, ["FAILED", "UNKNOWN"]);
  assert.equal(failed.state, "FAILED");
  assert.match(JSON.stringify(failed.result), /known-exit/);

  const shortBridge = await createProcessBridge({ ...bridgeOptions, maxPollMs: 150 });
  const second = createDurableKernel({ store: new DurableStore(path.join(fixture.state, "observation-core.sqlite")), authorize: () => ({ decision: "ALLOW" }), revalidate: () => true });
  kernels.push(second); second.kernel.register(shortBridge.capabilities[0]!);
  const continuedMarker = path.join(fixture.workspace, "continued.txt");
  const observation = second.kernel.submit(context, { capability: "process_run", input: { executable: process.execPath, args: ["-e", `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(continuedMarker)},'continued');console.log('later-receipt');},650)`] }, idempotencyKey: "observation-only" });
  const uncertain = await waitState(second.kernel, observation.executionId, ["UNKNOWN", "FAILED"]);
  assert.equal(uncertain.state, "UNKNOWN");
  assert.match(JSON.stringify(uncertain.result), /PROCESS_OBSERVATION_DEADLINE/);
  await second.kernel.close();
  for (let index = 0; index < 100 && !fs.existsSync(continuedMarker); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(continuedMarker, "utf8"), "continued", "ending Core observation does not stop external work");
  for (let index = 0; index < 100 && (await bridge.statusForRun(uncertain)).state !== "EXITED"; index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await bridge.statusForRun(uncertain)).receipt?.exitCode, 0);

  const cancelling = createDurableKernel({ store: new DurableStore(path.join(fixture.state, "cancel-core.sqlite")), authorize: () => ({ decision: "ALLOW" }), revalidate: () => true });
  kernels.push(cancelling); cancelling.kernel.register(shortBridge.capabilities[0]!);
  const cancelStarted = path.join(fixture.workspace, "cancel-started.txt");
  const cancelEffect = path.join(fixture.workspace, "cancel-late-effect.txt");
  orphanDeadline = Date.now() + 4500;
  const cancelRun = cancelling.kernel.submit(context, { capability: "process_run", input: { executable: process.execPath, args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(cancelStarted)},'s');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(cancelEffect)},'unexpected'),3000)`] }, idempotencyKey: "cancel-after-unknown" });
  const cancelUnknown = await waitState(cancelling.kernel, cancelRun.executionId, ["UNKNOWN", "FAILED"]);
  assert.equal(cancelUnknown.state, "UNKNOWN");
  assert.match(JSON.stringify(cancelUnknown.result), /PROCESS_OBSERVATION_DEADLINE/);
  const original = await bridge.statusForRun(cancelUnknown);
  assert.equal(original.state, "RUNNING");
  await assert.rejects(bridge.cancelForRun({ ...cancelUnknown, context: { ...cancelUnknown.context, principal: "other-owner" } }),
    (error: unknown) => error instanceof DurableError && error.code === "PROCESS_RUN_BINDING_MISMATCH");
  assert.equal((await bridge.statusForRun(cancelUnknown)).state, "RUNNING");
  const cancelView = await bridge.cancelForRun(cancelUnknown);
  assert.equal(cancelView.id, original.id);
  assert.equal(cancelView.dispatchKey, original.dispatchKey);
  let terminated = cancelView;
  for (let index = 0; index < 100 && terminated.state !== "EXITED"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminated = await bridge.statusForRun(cancelUnknown);
  }
  assert.equal(terminated.state, "EXITED");
  assert.equal(terminated.receipt?.cancelRequested, true);
  assert.equal(terminated.receipt?.directTermination, "confirmed");
  assert.equal(terminated.receipt?.treeTermination, "unconfirmed");
  assert.equal(cancelling.kernel.status(owner, cancelRun.executionId).state, "UNKNOWN", "cancel must not fabricate a known Core terminal state");
  assert.equal(fs.readFileSync(cancelStarted, "utf8"), "s", "cancel only addresses the original dispatch");
  assert.equal(fs.existsSync(cancelEffect), false);
  orphanDeadline = 0;

  const detachedDb = path.join(fixture.state, "detached-core.sqlite");
  const detaching = createDurableKernel({ store: new DurableStore(detachedDb), authorize: () => ({ decision: "ALLOW" }), revalidate: () => true });
  kernels.push(detaching); detaching.kernel.register(bridge.capabilities[0]!);
  const detachedStarted = path.join(fixture.workspace, "detached-started.txt");
  const detachedEffect = path.join(fixture.workspace, "detached-finished.txt");
  const detachedRun = detaching.kernel.submit(context, { capability: "process_run", input: { executable: process.execPath, args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(detachedStarted)},'s');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(detachedEffect)},'finished'),700)`] }, idempotencyKey: "core-close-detaches" });
  for (let index = 0; index < 200 && !fs.existsSync(detachedStarted); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(detachedStarted));
  const active = detaching.kernel.status(owner, detachedRun.executionId);
  assert.equal(active.state, "RUNNING");
  const detachedOriginal = await bridge.statusForRun(active);
  await detaching.kernel.close();
  const reopened = createDurableKernel({ store: new DurableStore(detachedDb), authorize: () => ({ decision: "ALLOW" }), revalidate: () => true });
  kernels.push(reopened); reopened.kernel.register(bridge.capabilities[0]!);
  const recovered = reopened.kernel.status(owner, detachedRun.executionId);
  assert.equal(recovered.state, "UNKNOWN");
  assert.match(JSON.stringify(recovered.result), /PROCESS_CORE_DETACHED/);
  let detachedReceipt = await bridge.statusForRun(recovered);
  for (let index = 0; index < 100 && detachedReceipt.state !== "EXITED"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    detachedReceipt = await bridge.statusForRun(recovered);
  }
  assert.equal(detachedReceipt.id, detachedOriginal.id);
  assert.equal(detachedReceipt.dispatchKey, detachedOriginal.dispatchKey);
  assert.equal(detachedReceipt.state, "EXITED");
  assert.equal(detachedReceipt.receipt?.cancelRequested, false);
  assert.equal(detachedReceipt.receipt?.exitCode, 0);
  assert.equal(fs.readFileSync(detachedEffect, "utf8"), "finished");
  assert.equal(fs.readFileSync(detachedStarted, "utf8"), "s", "Core restart must query the original dispatch without replay");

  const crashMarker = path.join(fixture.workspace, "crash-started.txt");
  const crash = pair.kernel.submit(context, { capability: "process_run", input: { executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(crashMarker)},'started');setTimeout(()=>{},600)`] }, idempotencyKey: "host-loss" });
  const crashPending = await waitState(pair.kernel, crash.executionId, ["WAITING_APPROVAL"]);
  pair.operator.decide({ approvalId: crashPending.approval!.approvalId, expectedDecisionVersion: crashPending.approval!.decisionVersion, decision: "APPROVE", actor: "local-operator" });
  for (let index = 0; index < 200 && !fs.existsSync(crashMarker); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(crashMarker));
  orphanDeadline = Date.now() + 1000;
  await stopHost(child);
  const lost = await waitState(pair.kernel, crash.executionId, ["UNKNOWN", "FAILED"]);
  assert.equal(lost.state, "UNKNOWN", "loss of receipt must not masquerade as known failure");
  assert.match(JSON.stringify(lost.result), /PROCESS_CONNECTION_UNCONFIRMED/);
  await assert.rejects(bridge.cancelForRun(lost), (error: unknown) => error instanceof UnconfirmedOutcome && error.code === "PROCESS_CANCEL_UNCONFIRMED");
  console.log("V3_PROCESS_BRIDGE_OK (real approval, junction credential rejection, bounded output, dedup, UNKNOWN cancellation, Core-close detach and reconnect, typed failure and unreachable uncertainty)");
} finally {
  await coreRpc?.close();
  await Promise.all(kernels.map((pair) => pair.kernel.close()));
  await stopHost(child);
  if (Date.now() < orphanDeadline) await new Promise((resolve) => setTimeout(resolve, orphanDeadline - Date.now()));
  await fixture.remove();
}
