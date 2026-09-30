import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { createRpcClient } from "../v3/transport/rpc.js";
import type { LifecycleRestartRecord } from "../v3/lifecycle.js";

const fixture = await createPrivateV3Fixture();
const configDir = path.join(fixture.state, "configuration");
const stateDir = path.join(fixture.state, "core-state");
fs.mkdirSync(configDir, { mode: 0o700 });
const configFile = path.join(configDir, "core.json");
fs.writeFileSync(configFile, JSON.stringify({
  version: 1, slotId: "A", stateDir,
  workspaceId: "lifecycle-test", workspaceRoot: fixture.workspace,
  authorizationRevision: "1", principal: "lifecycle-user",
  optionalRuntime: false, workflowAutoAdvance: false
}), { mode: 0o600 });

const mainEntry = fileURLToPath(new URL("../v3-main.js", import.meta.url));
assert.ok(fs.existsSync(mainEntry), "Compile v3-main before lifecycle acceptance");
const children: ChildProcess[] = [];

function launch() {
  const script = `process.on('message',m=>{if(m==='test-sigterm')process.emit('SIGTERM')});await import(${JSON.stringify(pathToFileURL(mainEntry).href)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, P05_V3_CONFIG: configFile }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, output: () => stdout + "\n" + stderr };
}

async function event(process: ReturnType<typeof launch>, name: string) {
  for (let i = 0; i < 1500; i++) {
    for (const line of process.output().split(/\r?\n/)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.event === name) return value;
      } catch { /* incomplete/non-JSON output */ }
    }
    if (process.child.exitCode !== null) throw new Error(`Lifecycle Core exited before ${name}: ${process.output()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`LIFECYCLE_EVENT_TIMEOUT:${name}`);
}

try {
  const main = launch();
  const ready = await event(main, "p05.v3.ready") as {
    endpoint: string; operatorTokenFile: string; coreInstanceId: string; instanceGeneration: number;
  };
  const operatorToken = fs.readFileSync(ready.operatorTokenFile, "utf8").trim();
  const firstRpc = createRpcClient({ url: ready.endpoint, token: operatorToken });
  const before = await firstRpc.call("core_status", {}) as { coreInstanceId: string; instanceGeneration: number; liveness: boolean };
  assert.equal(before.liveness, true);
  assert.equal(before.coreInstanceId, ready.coreInstanceId);
  assert.equal(before.instanceGeneration, ready.instanceGeneration);

  const accepted = await firstRpc.call("operator_lifecycle_restart", { idempotencyKey: "restart-once" }) as LifecycleRestartRecord;
  assert.equal(accepted.state, "ACK_PENDING");
  assert.equal(accepted.requestedGeneration, before.instanceGeneration);
  assert.equal(accepted.requestedCoreInstanceId, before.coreInstanceId);

  const restarted = await event(main, "p05.v3.restarted") as {
    endpoint: string; lifecycleId: string; coreInstanceId: string; instanceGeneration: number;
    previousCoreInstanceId: string; previousGeneration: number; receipt: LifecycleRestartRecord;
  };
  assert.equal(restarted.lifecycleId, accepted.lifecycleId);
  assert.equal(restarted.previousCoreInstanceId, before.coreInstanceId);
  assert.equal(restarted.previousGeneration, before.instanceGeneration);
  assert.equal(restarted.instanceGeneration, before.instanceGeneration + 1);
  assert.notEqual(restarted.coreInstanceId, before.coreInstanceId);

  const connection = JSON.parse(fs.readFileSync(path.join(stateDir, "slots", "a", "connection.json"), "utf8")) as { endpoint: string };
  assert.equal(connection.endpoint, restarted.endpoint);
  const secondRpc = createRpcClient({ url: restarted.endpoint, token: operatorToken });
  const receipt = await secondRpc.call("operator_lifecycle_status", { id: accepted.lifecycleId }) as LifecycleRestartRecord;
  assert.equal(receipt.state, "SUCCEEDED");
  assert.equal(receipt.completedGeneration, before.instanceGeneration + 1);
  assert.equal(receipt.completedCoreInstanceId, restarted.coreInstanceId);
  assert.equal(receipt.health?.liveness, true);
  assert.equal(receipt.health?.protectionVerified, true);
  assert.equal(receipt.health?.executionAvailable, true);

  const after = await secondRpc.call("core_status", {}) as { coreInstanceId: string; instanceGeneration: number; liveness: boolean };
  assert.equal(after.coreInstanceId, receipt.completedCoreInstanceId);
  assert.equal(after.instanceGeneration, receipt.completedGeneration);
  assert.equal(after.liveness, true);

  const repeated = await secondRpc.call("operator_lifecycle_restart", { idempotencyKey: "restart-once" }) as LifecycleRestartRecord;
  assert.equal(repeated.lifecycleId, accepted.lifecycleId);
  assert.equal(repeated.state, "SUCCEEDED");
  await new Promise(resolve => setTimeout(resolve, 250));
  const unchanged = await secondRpc.call("core_status", {}) as { instanceGeneration: number };
  assert.equal(unchanged.instanceGeneration, after.instanceGeneration, "idempotent retry must not dispatch a second restart");

  if (process.platform === "win32") main.child.send("test-sigterm");
  else main.child.kill("SIGTERM");
  assert.equal(await main.closed, 0);
  console.log("V3_LIFECYCLE_OK (durable ACK_PENDING, post-flush dispatch, supervised Core generation restart, reconnect health receipt, idempotent no-double-restart)");
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }
  await fixture.remove();
}