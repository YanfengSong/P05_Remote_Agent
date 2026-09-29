import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRpcClient, type RpcClient } from "../v3/transport/rpc.js";
import { ProcessExecutionHost, type ProcessOwner, type ProcessView } from "../v3/process/host.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";

const privateFixture = await createPrivateV3Fixture();
const fixture = privateFixture.root;
const workspace = privateFixture.workspace;
const stateDir = path.join(privateFixture.state, "executor-state");
const configDir = path.join(privateFixture.state, "configuration");
fs.mkdirSync(stateDir, { mode: 0o700 });
fs.mkdirSync(configDir, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
const tokenFile = path.join(configDir, "core-token");
const operatorTokenFile = path.join(configDir, "operator-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
fs.writeFileSync(operatorTokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const configFile = path.join(configDir, "config.json");
fs.writeFileSync(configFile, JSON.stringify({ stateDir, workspaceRoot: workspace, slot: "B", principal: "core-test", securityMode: "trusted-host", clientTokenFile: tokenFile, operatorTokenFile, maxOutputBytes: 8192 }), { mode: 0o600 });
const entrypoint = fileURLToPath(new URL("../v3-process-host.js", import.meta.url));
assert.ok(fs.existsSync(entrypoint), "compile the actual standalone Process Host before this test");
const children = new Set<ChildProcess>();
const owner: ProcessOwner = { slot: "B", principal: "core-test", runId: "run-1", attemptId: "attempt-1" };
let orphanDeadline = 0;

async function start(): Promise<{ child: ChildProcess; client: RpcClient; url: string }> {
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, P05_V3_PROCESS_CONFIG: configFile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  let errors = "";
  child.stderr?.on("data", (part) => { if (errors.length < 8192) errors += String(part); });
  child.stdout?.resume();
  child.once("exit", () => children.delete(child));
  for (let index = 0; index < 1000; index += 1) {
    if (child.exitCode !== null) throw new Error("Process Host exited during startup: " + errors);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(stateDir, "endpoint.json"), "utf8")) as { pid: number; url: string };
      if (metadata.pid === child.pid) return { child, client: createRpcClient({ url: metadata.url, token }), url: metadata.url };
    } catch { /* wait for this process's endpoint publication */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Process Host startup deadline exceeded");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function view(client: RpcClient, id: string): Promise<ProcessView> {
  const result = await client.call("process_status", { id, owner }) as ProcessView & { error?: unknown };
  assert.equal(result.error, undefined);
  return result;
}
async function terminal(client: RpcClient, id: string): Promise<ProcessView> {
  for (let index = 0; index < 300; index += 1) {
    const result = await view(client, id);
    if (["EXITED", "FAILED", "UNKNOWN"].includes(result.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Process completion deadline exceeded");
}

try {
  let running = await start();
  assert.throws(() => new ProcessExecutionHost({ stateDir, workspaceRoot: workspace, slot: "B", principal: "core-test", securityMode: "trusted-host" }), /HOST_ALREADY_RUNNING/);
  assert.throws(() => new ProcessExecutionHost({ stateDir: workspace, workspaceRoot: workspace, slot: "B", principal: "core-test", securityMode: "trusted-host" }), /STATE_WORKSPACE_OVERLAP/);
  const marker = path.join(workspace, "once.txt");
  const args = ["-e", `setTimeout(() => { require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); console.log('finished-after-core-disconnected'); }, 700);`];
  const submission = { dispatchKey: "detach-once", owner, executable: process.execPath, args };
  const clientModule = new URL("../v3/transport/rpc.js", import.meta.url).href;
  // A separate short-lived Core surrogate submits and exits; Host and workload remain independent.
  const detached = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRpcClient } from ${JSON.stringify(clientModule)};
    const client = createRpcClient({ url: ${JSON.stringify(running.url)}, token: process.env.PROCESS_TEST_TOKEN });
    const result = await client.call("process_submit", ${JSON.stringify(submission)});
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  `], { env: { ...process.env, PROCESS_TEST_TOKEN: token }, windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.equal(detached.status, 0, detached.stderr);
  const accepted = JSON.parse(detached.stdout) as ProcessView;
  assert.ok(accepted.id);
  assert.equal(fs.existsSync(marker), false, "Core surrogate exits before delayed process side effect");
  const repeated = await running.client.call("process_submit", submission) as ProcessView;
  assert.equal(repeated.id, accepted.id);
  const done = await terminal(running.client, accepted.id);
  assert.equal(done.state, "EXITED");
  assert.equal(done.receipt?.exitCode, 0);
  assert.equal(done.receipt?.treeTermination, "unconfirmed");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  assert.equal((await running.client.call("process_submit", submission) as ProcessView).id, accepted.id);
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  const conflict = await running.client.call("process_submit", { ...submission, args: ["-e", "process.exit(0)"] }) as { error: { code: string } };
  assert.equal(conflict.error.code, "DISPATCH_CONFLICT");

  for (const method of ["process_status", "process_output", "process_cancel"]) {
    const denied = await running.client.call(method, { id: accepted.id, owner: { ...owner, runId: "someone-else" } }) as { error: { code: string } };
    assert.equal(denied.error.code, "PROCESS_NOT_FOUND");
    const wrongPrincipal = await running.client.call(method, { id: accepted.id, owner: { ...owner, principal: "remote-edge" } }) as { error: { code: string } };
    assert.equal(wrongPrincipal.error.code, "OWNER_MISMATCH");
  }
  const rootChange = await running.client.call("process_submit", { ...submission, dispatchKey: "bad-root", workspaceRoot: fixture }) as { error: { code: string } };
  assert.equal(rootChange.error.code, "INVALID_INPUT");

  const noisy = await running.client.call("process_submit", { dispatchKey: "noisy", owner, executable: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(70000));process.stderr.write('b'.repeat(70000));"] }) as ProcessView;
  const noisyDone = await terminal(running.client, noisy.id);
  assert.equal(noisyDone.truncated, true);
  assert.ok(noisyDone.stdoutBytes + noisyDone.stderrBytes <= 8192);
  const page = await running.client.call("process_output", { id: noisy.id, owner, stream: "stdout", offset: 0, limit: 1024 }) as { dataBase64: string; nextOffset: number };
  assert.equal(Buffer.from(page.dataBase64, "base64").length, 1024);
  assert.equal(page.nextOffset, 1024);
  const rest = await running.client.call("process_output", { id: noisy.id, owner, stream: "stdout", offset: 1024, limit: 65536 }) as { dataBase64: string; nextOffset: number };
  assert.ok(Buffer.from(rest.dataBase64, "base64").length <= 65536);
  assert.equal(rest.nextOffset, noisyDone.stdoutBytes);
  const invalidPage = await running.client.call("process_output", { id: noisy.id, owner, offset: 0, limit: 65537 }) as { error: { code: string } };
  assert.equal(invalidPage.error.code, "INVALID_INPUT");
  const db = new DatabaseSync(path.join(stateDir, "processes.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM output_pages WHERE process_id=?").get(noisy.id) as { n: number };
    assert.ok(rows.n <= 3, "fixed-size pages prevent per-chunk unbounded SQLite row fragmentation");
  } finally { db.close(); }

  const cancellable = await running.client.call("process_submit", { dispatchKey: "cancel", owner, executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }) as ProcessView;
  for (let index = 0; index < 100 && (await view(running.client, cancellable.id)).state !== "RUNNING"; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await running.client.call("process_cancel", { id: cancellable.id, owner });
  const cancelled = await terminal(running.client, cancellable.id);
  assert.equal(cancelled.receipt?.cancelRequested, true);
  assert.equal(cancelled.receipt?.directTermination, "confirmed");
  assert.equal(cancelled.receipt?.treeTermination, "unconfirmed");

  const started = path.join(workspace, "orphan-started.txt");
  const orphanResult = path.join(workspace, "orphan-result.txt");
  const uncertainInput = {
    dispatchKey: "uncertain", owner, executable: process.execPath,
    args: ["-e", `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(started)},'s');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(orphanResult)},'x');},900);`]
  };
  const uncertain = await running.client.call("process_submit", uncertainInput) as ProcessView;
  for (let index = 0; index < 100 && !fs.existsSync(started); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(started));
  orphanDeadline = Date.now() + 1400;
  const oldBoot = uncertain.executorBootId;
  await stop(running.child);
  running = await start();
  const recovered = await view(running.client, uncertain.id);
  assert.equal(recovered.state, "UNKNOWN");
  assert.equal(recovered.executorBootId, oldBoot);
  assert.equal(recovered.receipt?.reason, "EXECUTOR_RESTART");
  assert.equal((await running.client.call("process_submit", uncertainInput) as ProcessView).id, uncertain.id);
  assert.equal((await view(running.client, uncertain.id)).state, "UNKNOWN");
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, orphanDeadline - Date.now())));
  assert.equal(fs.readFileSync(started, "utf8"), "s", "unknown work must never be silently replayed");
  // Host termination can also terminate the child on some OS/job configurations.
  // UNKNOWN is correct in either case; the implementation must not guess success.
  assert.ok(!fs.existsSync(orphanResult) || fs.readFileSync(orphanResult, "utf8") === "x");
  assert.equal((await view(running.client, accepted.id)).receipt?.exitCode, 0, "completed receipts survive Host restart");
  const retained = await running.client.call("process_output", { id: noisy.id, owner, offset: 0, limit: 1024 }) as { dataBase64: string };
  assert.equal(retained.dataBase64, page.dataBase64);
  console.log("V3_PROCESS_OK (independent Host, Core detach, durable dedup/receipt, ownership, bounded output pages, explicit cancellation limits, crash UNKNOWN without replay)");
} finally {
  await Promise.all([...children].map(stop));
  if (Date.now() < orphanDeadline) await new Promise((resolve) => setTimeout(resolve, orphanDeadline - Date.now()));
  await privateFixture.remove();
}
