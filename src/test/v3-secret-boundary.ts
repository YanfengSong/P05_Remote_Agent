import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { ArtifactStore, ArtifactStoreError } from "../v3/artifacts.js";
import { createDurableKernel } from "../v3/durable/kernel.js";
import { DurableStore } from "../v3/durable/store.js";
import type { ExecutionContext, Json, Run } from "../v3/durable/types.js";
import { createProcessBridge } from "../v3/process-bridge.js";
import { createSecretSafeBackup, SecretSafeBackupError } from "../v3/secret-safe-backup.js";
import { InMemorySecretManager, SecretError, StreamingSecretRedactor } from "../v3/secrets.js";

const fixture = await createPrivateV3Fixture();
const hostState = path.join(fixture.state, "executor");
const configDir = path.join(fixture.state, "configuration");
const artifactRoot = path.join(fixture.state, "artifacts");
fs.mkdirSync(hostState, { mode: 0o700 });
fs.mkdirSync(configDir, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
const tokenFile = path.join(configDir, "executor-token");
const operatorTokenFile = path.join(configDir, "executor-operator-token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
fs.writeFileSync(operatorTokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const configFile = path.join(configDir, "executor.json");
fs.writeFileSync(configFile, JSON.stringify({ stateDir: hostState, workspaceRoot: fixture.workspace, slot: "B", principal: "secret-owner", securityMode: "trusted-host", clientTokenFile: tokenFile, operatorTokenFile }), { mode: 0o600 });
const hostEntry = fileURLToPath(new URL("../v3-process-host.js", import.meta.url));
const child = spawn(process.execPath, [hostEntry], { env: { ...process.env, P05_V3_PROCESS_CONFIG: configFile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout?.resume(); child.stderr?.resume();

const context: ExecutionContext = {
  hostId: "secret-host",
  slotId: "B",
  principal: "secret-owner",
  workspaceId: "secret-workspace",
  workspaceRoot: fs.realpathSync(fixture.workspace),
  authorizationRevision: "1"
};
const owner = { slotId: context.slotId, principal: context.principal };
const secretValue = "T27-credential-8d91f0e2";
const secrets = new InMemorySecretManager();
secrets.register({ secretId: "api-token", principalId: context.principal, workspaceId: context.workspaceId, value: secretValue });
let resolutions = 0;
const resolver = {
  resolveForExecution(reference: any, executionContext: any) {
    resolutions++;
    return secrets.resolveForExecution(reference, executionContext);
  }
};
const coreDb = path.join(fixture.state, "core-secret.sqlite");
const pair = createDurableKernel({
  store: new DurableStore(coreDb),
  authorize: () => ({ decision: "CONFIRM", reason: "T27 secret command approval", expiresAt: Date.now() + 60_000 }),
  revalidate: () => true
});
let artifacts: ArtifactStore | undefined;

async function stopHost(target: ChildProcess): Promise<void> {
  if (target.exitCode !== null || target.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
  target.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  if (target.exitCode === null && target.signalCode === null) { target.kill("SIGKILL"); await exited; }
}
async function waitRun(id: string, states: string[]): Promise<Run> {
  for (let i = 0; i < 400; i++) {
    const run = pair.kernel.status(owner, id);
    if (states.includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("T27_RUN_TIMEOUT");
}
function artifactCode(code: string) {
  return (error: unknown) => error instanceof ArtifactStoreError && error.code === code;
}

try {
  const streaming = new StreamingSecretRedactor([secretValue]);
  const split = Buffer.concat([
    streaming.push(Buffer.from("prefix:" + secretValue.slice(0, 7))),
    streaming.push(Buffer.from(secretValue.slice(7) + ":suffix")),
    streaming.flush()
  ]).toString("utf8");
  assert.equal(split, "prefix:[REDACTED]:suffix", "streaming redaction must catch secrets split across chunks");

  assert.throws(() => secrets.resolveForExecution({ $secretRef: "api-token", prefix: "", suffix: "" }, {
    principalId: "other-principal", workspaceId: context.workspaceId, purpose: "process-argument"
  }), (error: unknown) => error instanceof SecretError && error.code === "SECRET_NOT_FOUND");

  let endpoint = "";
  for (let i = 0; i < 1000; i++) {
    if (child.exitCode !== null) throw new Error("T27_PROCESS_HOST_START_FAILED");
    try { endpoint = (JSON.parse(fs.readFileSync(path.join(hostState, "endpoint.json"), "utf8")) as { url: string }).url; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(endpoint);
  const connectionFile = path.join(configDir, "connection.json");
  fs.writeFileSync(connectionFile, JSON.stringify({ version: 1, url: endpoint, clientTokenFile: tokenFile, slot: "B", principal: context.principal, workspaceRoot: fixture.workspace, securityMode: "trusted-host" }), { mode: 0o600 });

  const bridge = await createProcessBridge({
    connectionFile,
    slotId: "B",
    principal: context.principal,
    workspaceRoot: fixture.workspace,
    pollIntervalMs: 10,
    rpcTimeoutMs: 1500,
    summaryBytes: 8192,
    secretResolver: resolver
  });
  pair.kernel.register(bridge.capabilities[0]!);

  const script = [
    "const s=process.argv[1];",
    "process.stdout.write('stdout:'+s.slice(0,7));",
    "setTimeout(()=>{process.stdout.write(s.slice(7));process.stderr.write('stderr:'+s);process.exit(7)},25);"
  ].join("");
  const input: Json = {
    executable: process.execPath,
    args: ["-e", script, { $secretRef: "api-token", prefix: "", suffix: "" }]
  };
  const submitted = pair.kernel.submit(context, { capability: "process_run", input, idempotencyKey: "secret-command" });
  const pending = await waitRun(submitted.executionId, ["WAITING_APPROVAL"]);
  assert.equal(resolutions, 0, "policy/approval/audit path must not dereference SecretRef before execution");
  const rawCoreBefore = fs.readFileSync(coreDb);
  assert.equal(secrets.containsSecret(rawCoreBefore), false, "Core durable state stores SecretRef, not plaintext secret");
  const coreRows = new DatabaseSync(coreDb, { readOnly: true });
  try {
    const row = coreRows.prepare("SELECT input FROM runs WHERE id=?").get(submitted.executionId) as { input: string };
    assert.match(row.input, /api-token/);
    assert.equal(row.input.includes(secretValue), false);
  } finally { coreRows.close(); }

  pair.operator.decide({
    approvalId: pending.approval!.approvalId,
    expectedDecisionVersion: pending.approval!.decisionVersion,
    decision: "APPROVE",
    actor: "local-operator"
  });
  const done = await waitRun(submitted.executionId, ["FAILED", "UNKNOWN", "SUCCEEDED"]);
  assert.equal(done.state, "FAILED", JSON.stringify(done.result));
  assert.equal(resolutions, 1, "SecretRef is dereferenced exactly at the execution boundary");
  const resultText = JSON.stringify(done.result);
  assert.equal(resultText.includes(secretValue), false);
  assert.match(resultText, /\[REDACTED\]/, "confirmed failure evidence is redacted before entering Core state");

  const processDb = path.join(hostState, "processes.sqlite");
  const processRows = new DatabaseSync(processDb, { readOnly: true });
  try {
    const row = processRows.prepare("SELECT input FROM processes WHERE dispatch_key=?").get(submitted.executionId + ":attempt1") as { input: string };
    assert.equal(row.input.includes(secretValue), false, "persisted command args must not contain plaintext secret");
    assert.match(row.input, /\[REDACTED\]/);
    const pages = processRows.prepare("SELECT bytes FROM output_pages WHERE process_id=(SELECT id FROM processes WHERE dispatch_key=?) ORDER BY stream,page").all(submitted.executionId + ":attempt1") as { bytes: Uint8Array }[];
    const output = Buffer.concat(pages.map(page => Buffer.from(page.bytes))).toString("utf8");
    assert.equal(output.includes(secretValue), false, "persisted process output must be redacted");
    assert.match(output, /\[REDACTED\]/);
  } finally { processRows.close(); }

  const missingInput: Json = { executable: process.execPath, args: ["-e", "process.exit(0)", { $secretRef: "missing-secret", prefix: "", suffix: "" }] };
  const missing = pair.kernel.submit(context, { capability: "process_run", input: missingInput, idempotencyKey: "missing-secret" });
  const missingPending = await waitRun(missing.executionId, ["WAITING_APPROVAL"]);
  pair.operator.decide({ approvalId: missingPending.approval!.approvalId, expectedDecisionVersion: missingPending.approval!.decisionVersion, decision: "APPROVE", actor: "local-operator" });
  const missingDone = await waitRun(missing.executionId, ["FAILED"]);
  assert.equal(JSON.stringify(missingDone.result).includes(secretValue), false);
  assert.match(JSON.stringify(missingDone.result), /SECRET_RESOLUTION_FAILED/, "resolver exceptions collapse to a stable non-secret code");

  artifacts = new ArtifactStore({
    root: artifactRoot,
    now: () => 1_000,
    defaultRetentionMs: 60_000,
    redactContent: (bytes) => secrets.redactBuffer(bytes)
  });
  const artifactStore = artifacts;
  const artifact = artifactStore.publish({
    producerRun: "run-artifact",
    principalId: context.principal,
    workspaceId: context.workspaceId,
    visibility: "private",
    mediaType: "text/plain",
    content: "diagnostic token=" + secretValue
  });
  const artifactOwner = { principalId: context.principal, workspaceId: context.workspaceId };
  const artifactBytes = artifactStore.read(artifactOwner, artifact.artifactId);
  assert.equal(artifactBytes.toString().includes(secretValue), false);
  assert.equal(artifactBytes.toString(), "diagnostic token=[REDACTED]");
  assert.throws(() => artifactStore.read({ principalId: "other-principal", workspaceId: context.workspaceId }, artifact.artifactId), artifactCode("ARTIFACT_NOT_FOUND"));

  artifactStore.close(); artifacts = undefined;
  await pair.kernel.close();
  await stopHost(child);

  const persistentFiles = [
    coreDb,
    processDb,
    path.join(artifactRoot, "artifacts.sqlite")
  ].flatMap(file => [file, file + "-wal", file + "-shm"].filter(candidate => fs.existsSync(candidate)));
  const blobFiles: string[] = [];
  const blobRoot = path.join(artifactRoot, "blobs");
  if (fs.existsSync(blobRoot)) for (const prefix of fs.readdirSync(blobRoot)) {
    const directory = path.join(blobRoot, prefix);
    if (fs.statSync(directory).isDirectory()) for (const name of fs.readdirSync(directory)) blobFiles.push(path.join(directory, name));
  }
  for (const file of [...persistentFiles, ...blobFiles]) {
    assert.equal(secrets.containsSecret(fs.readFileSync(file)), false, "persistent state must be secret-free: " + path.basename(file));
  }

  const backupSources = [...persistentFiles, ...blobFiles].map((file, index) => ({ name: "state-" + index + path.extname(file), file }));
  const backupDir = path.join(fixture.root, "safe-backup");
  const backup = createSecretSafeBackup({ destination: backupDir, sources: backupSources, containsSecret: bytes => secrets.containsSecret(bytes) });
  assert.ok(backup.files.length >= 3);
  for (const file of backup.files) assert.equal(secrets.containsSecret(fs.readFileSync(file)), false);

  const contaminated = path.join(fixture.root, "contaminated.bin");
  fs.writeFileSync(contaminated, Buffer.from("backup-leak:" + secretValue));
  const rejectedDestination = path.join(fixture.root, "rejected-backup");
  assert.throws(() => createSecretSafeBackup({
    destination: rejectedDestination,
    sources: [{ name: "bad.bin", file: contaminated }],
    containsSecret: bytes => secrets.containsSecret(bytes)
  }), (error: unknown) => error instanceof SecretSafeBackupError && error.code === "BACKUP_SECRET_DETECTED");
  assert.equal(fs.existsSync(rejectedDestination), false, "secret-bearing backup fails before publishing any destination");

  console.log("V3_T27_SECRET_BOUNDARY_OK (SecretRef stays durable, late execution-only resolution, command/output/error redaction, private Artifact sanitization, secret-scanned backup fail-closed)");
} finally {
  artifacts?.close();
  await pair.kernel.close().catch(() => undefined);
  await stopHost(child);
  await fixture.remove();
}
