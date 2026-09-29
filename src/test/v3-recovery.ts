import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { inspectV3Recovery, type RecoveryInspection } from "../v3/recovery.js";
import { createRpcClient } from "../v3/transport/rpc.js";

const fixture = await createPrivateV3Fixture();
const configDir = path.join(fixture.state, "configuration");
const stateDir = path.join(fixture.state, "core-state");
fs.mkdirSync(configDir, { mode: 0o700 });
const configFile = path.join(configDir, "core.json");
fs.writeFileSync(configFile, JSON.stringify({ version: 1, slotId: "A", stateDir,
  workspaceId: "recovery-test", workspaceRoot: fixture.workspace, authorizationRevision: "1", principal: "recovery-user", optionalRuntime: false }), { mode: 0o600 });
fs.writeFileSync(path.join(fixture.workspace, "read.txt"), "preserved-run");
const recoveryEntry = fileURLToPath(new URL("../v3-recovery.js", import.meta.url));
const mainEntry = fileURLToPath(new URL("../v3-main.js", import.meta.url));
assert.ok(fs.existsSync(recoveryEntry) && fs.existsSync(mainEntry), "Compile the real recovery CLI and Core entry before testing");
const children: ChildProcess[] = [];
function launch(entry: string, args: string[] = []) {
  // Windows child.kill(SIGTERM) is a hard termination. IPC is a test-only means of
  // delivering the actual SIGTERM handler without adding a production control API.
  const script = `process.argv=${JSON.stringify([process.execPath, entry, ...args])};process.on('message',m=>{if(m==='test-sigterm')process.emit('SIGTERM')});await import(${JSON.stringify(pathToFileURL(entry).href)});if(!process.listenerCount('SIGTERM'))process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, P05_V3_CONFIG: configFile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RECOVERY_TEST_TIMEOUT")), 30000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function ready(process: ReturnType<typeof launch>, event: string): Promise<{ endpoint: string; coreInstanceId?: string; instanceGeneration?: number }> {
  for (let index = 0; index < 1500; index += 1) {
    for (const line of (process.stdout() + "\n" + process.stderr()).split("\n")) {
      try { const value = JSON.parse(line) as { event: string; endpoint: string }; if (value.event === event) return value; } catch { /* incomplete line */ }
    }
    if (process.child.exitCode !== null) throw new Error(`Test Core exited before ready: ${process.stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("RECOVERY_READY_TIMEOUT");
}
async function cli(args: string[]) {
  // An inspect/error CLI must exit naturally, without the harness IPC listener.
  const child = spawn(process.execPath, [recoveryEntry, configFile, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await deadline(new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }));
  return { code, stdout, stderr };
}
try {
  const absent = await cli(["inspect"]);
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal((JSON.parse(absent.stdout) as RecoveryInspection).code, "STATE_NOT_FOUND");
  assert.equal(fs.existsSync(stateDir), false, "inspect must not initialize state");
  const first = launch(mainEntry);
  const initial = await ready(first, "p05.v3.ready");
  const tokenFile = path.join(stateDir, "slots", "a", "client.token");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const rpc = createRpcClient({ url: initial.endpoint, token });
  const submitted = await rpc.call("execution_submit", { capability: "fs_read", input: { path: "read.txt" }, idempotencyKey: "recovery-preserved" }) as { executionId: string };
  let original: { executionId: string; state: string; result: unknown } | undefined;
  for (let index = 0; index < 300; index += 1) {
    original = await rpc.call("execution_status", { id: submitted.executionId }) as typeof original;
    if (original?.state === "SUCCEEDED") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(original?.state, "SUCCEEDED");
  const owner = (await inspectV3Recovery(configFile)).owner!;
  assert.equal(owner.state, "active");
  const liveResume = await cli(["resume", owner.coreInstanceId, "Live lock must reject this test"]);
  assert.equal(liveResume.code, 1);
  assert.match(liveResume.stderr, /SLOT_ALREADY_OWNED/);
  assert.equal((await rpc.call("core_status", {}) as { coreInstanceId: string }).coreInstanceId, owner.coreInstanceId);
  first.child.kill("SIGKILL"); await deadline(first.closed);

  const snapshotFile = path.join(stateDir, "slots", "a", "core.sqlite");
  const fingerprint = () => createHash("sha256").update(fs.readFileSync(snapshotFile)).digest("hex");
  const beforeInspect = fingerprint();
  const crashed = await cli(["inspect"]);
  assert.equal(crashed.code, 0, crashed.stderr);
  assert.equal((JSON.parse(crashed.stdout) as RecoveryInspection).owner?.coreInstanceId, owner.coreInstanceId);
  assert.equal(fingerprint(), beforeInspect, "readonly inspect must not rewrite core.sqlite");
  const normal = launch(mainEntry);
  assert.equal(await deadline(normal.closed), 1, normal.stderr());
  const mismatch = await cli(["resume", randomUUID(), "Wrong owner must not be accepted"]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /RECOVERY_OWNER_MISMATCH/);
  assert.equal((await inspectV3Recovery(configFile)).owner?.coreInstanceId, owner.coreInstanceId);

  const reason = "Inspected isolated test executor state; acknowledge interrupted Core owner";
  const resumed = launch(recoveryEntry, [configFile, "resume", owner.coreInstanceId, reason]);
  const recovered = await ready(resumed, "p05.v3.recovered");
  assert.equal(recovered.instanceGeneration, owner.instanceGeneration + 1);
  assert.notEqual(recovered.coreInstanceId, owner.coreInstanceId);
  const resumedRpc = createRpcClient({ url: recovered.endpoint, token });
  assert.deepEqual(await resumedRpc.call("execution_status", { id: submitted.executionId }), original);
  const repeated = await resumedRpc.call("execution_submit", { capability: "fs_read", input: { path: "read.txt" }, idempotencyKey: "recovery-preserved" }) as { executionId: string };
  assert.equal(repeated.executionId, submitted.executionId);
  if (process.platform === "win32") resumed.child.send("test-sigterm");
  else resumed.child.kill("SIGTERM");
  assert.equal(await deadline(resumed.closed), 0);
  const released = await inspectV3Recovery(configFile);
  assert.equal(released.owner?.state, "released");
  assert.equal(released.owner?.coreInstanceId, recovered.coreInstanceId);
  const database = new DatabaseSync(snapshotFile, { readOnly: true });
  try {
    const recovery = database.prepare("SELECT value FROM core_state WHERE key=?").get(`recovery:${recovered.instanceGeneration}`) as { value: string };
    assert.equal(JSON.parse(recovery.value).reason, reason);
    assert.equal(JSON.parse(recovery.value).previousOwnerId, owner.coreInstanceId);
  } finally { database.close(); }
  console.log("V3_RECOVERY_OK (readonly inspect, absent state, real Core SIGKILL, live lock refusal, expected owner matching, generation and Run preservation, recorded reason, clean SIGTERM handler)");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }
  await fixture.remove();
}
