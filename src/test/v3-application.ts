import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startV3Application } from "../v3/application.js";
import { createRpcClient, startRpcServer } from "../v3/transport/rpc.js";
import { ProcessExecutionHost } from "../v3/process/host.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { acceptanceCatalog } from "./v3-workflow-catalog.js";

const fixture = await createPrivateV3Fixture();
const configFile = path.join(fixture.state, "config.json");
const workflowCatalog = path.join(fixture.state, "workflows.json");
await fs.writeFile(workflowCatalog, JSON.stringify(acceptanceCatalog("test")), { mode: 0o600 });
const processHost = new ProcessExecutionHost({ stateDir: path.join(fixture.state, "process-host"), workspaceRoot: fixture.workspace,
  slot: "A", principal: "fixture-user", securityMode: "trusted-host" });
const processToken = randomBytes(32).toString("hex");
const processServer = await startRpcServer({ clientToken: processToken, operatorToken: randomBytes(32).toString("hex"), handle: (method, input, role) => processHost.handle(method, input, role) });
const processTokenFile = path.join(fixture.state, "process-client.token");
await fs.writeFile(processTokenFile, processToken, { mode: 0o600 });
const processHostConnection = path.join(fixture.state, "process-connection.json");
await fs.writeFile(processHostConnection, JSON.stringify({ version: 1, url: processServer.url, clientTokenFile: processTokenFile,
  slot: "A", principal: "fixture-user", workspaceRoot: fixture.workspace, securityMode: "trusted-host" }), { mode: 0o600 });
const config = { version: 1, slotId: "A", stateDir: fixture.state, workspaceId: "test", workspaceRoot: fixture.workspace,
  authorizationRevision: "test-policy-1", principal: "fixture-user", port: 0, trustedHost: true, allowWrites: true, workflowCatalog, processHostConnection, allowHostExecute: true };
await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
await fs.writeFile(path.join(fixture.workspace, "input.txt"), "before\n");
execFileSync("git", ["init", "--quiet", fixture.workspace], { windowsHide: true });
let application: Awaited<ReturnType<typeof startV3Application>> | undefined;
let edge: Client | undefined;
type RunView = { executionId: string; state: string; stateVersion: number; result: unknown; approval: null | { approvalId: string; decisionVersion: number } };
async function awaitState(rpc: ReturnType<typeof createRpcClient>, id: string, desired: string): Promise<RunView> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = await rpc.call("execution_status", { id }) as RunView;
    if (run.state === desired) return run;
    if (["FAILED", "DENIED", "CANCELLED", "UNKNOWN"].includes(run.state)) assert.fail(`Expected ${desired}, got ${run.state}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out awaiting ${desired}`);
}
try {
  application = await startV3Application(configFile);
  const token = await fs.readFile(application.clientTokenFile, "utf8");
  let rpc = createRpcClient({ url: application.endpoint, token: token.trim() });
  let operator = createRpcClient({ url: application.endpoint, token: (await fs.readFile(application.operatorTokenFile, "utf8")).trim() });
  assert.equal(application.status().protection.verified, true);
  assert.equal(application.status().isolationVerified, false);
  const git = await rpc.call("execution_submit", { capability: "git_status", input: {}, idempotencyKey: randomUUID() }) as RunView;
  assert.ok((await awaitState(rpc, git.executionId, "SUCCEEDED")).result);
  const read = await rpc.call("execution_submit", { capability: "fs_read", input: { path: "input.txt" }, idempotencyKey: randomUUID() }) as RunView;
  assert.deepEqual((await awaitState(rpc, read.executionId, "SUCCEEDED")).result, { text: "before\n" });
  const input = { capability: "fs_write", input: { path: "output.txt", content: "approved\n", expectedSha256: null }, idempotencyKey: randomUUID() };
  const submitted = await rpc.call("execution_submit", input) as RunView;
  let pending = await awaitState(rpc, submitted.executionId, "WAITING_APPROVAL");
  assert.equal(await fs.stat(path.join(fixture.workspace, "output.txt")).then(() => true, () => false), false);
  assert.equal((await rpc.call("operator_approvals", {}) as { error: { code: string } }).error.code, "FORBIDDEN");
  const inspected = await operator.call("operator_inspect", { id: submitted.executionId }) as { input: unknown };
  assert.deepEqual(inspected.input, input.input);

  type WorkflowView = { runId: string; state: string; output: unknown; handoffs: unknown[]; invocations: { executionId?: string }[] };
  const workflow = await rpc.call("workflow_start", { workflowId: "local-acceptance", revision: "1", input: null, idempotencyKey: randomUUID(), reason: "Local integration acceptance" }) as WorkflowView;
  const advance = async (desired: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      // No tick calls: the resident scheduler must progress independently of the client.
      const view = await rpc.call("workflow_status", { id: workflow.runId }) as WorkflowView;
      if (view.state === desired) return view;
      assert.ok(!["FAILED", "PAUSED_UNKNOWN", "CANCELLED", "BUDGET_EXHAUSTED"].includes(view.state), JSON.stringify(view));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Workflow did not reach ${desired}`);
  };
  const workflowPending = await advance("WAITING_APPROVAL");
  const workflowExecution = workflowPending.invocations.at(-1)!.executionId!;

  // Close/reopen the actual application and SQLite files while an approval is pending.
  const firstGeneration = application.status().instanceGeneration;
  await application.close();
  application = await startV3Application(configFile);
  assert.ok(application.status().instanceGeneration > firstGeneration);
  rpc = createRpcClient({ url: application.endpoint, token: token.trim() });
  operator = createRpcClient({ url: application.endpoint, token: (await fs.readFile(application.operatorTokenFile, "utf8")).trim() });
  assert.equal((await rpc.call("workflow_status", { id: workflow.runId }) as WorkflowView).state, "WAITING_APPROVAL");
  const workflowApproval = await awaitState(rpc, workflowExecution, "WAITING_APPROVAL");
  await operator.call("operator_decide", { approvalId: workflowApproval.approval!.approvalId, expectedDecisionVersion: workflowApproval.approval!.decisionVersion, decision: "APPROVE" });
  const workflowResult = await advance("SUCCEEDED");
  assert.equal(workflowResult.handoffs.length, 2);
  assert.deepEqual(workflowResult.output, { text: "workflow verified\n" });
  pending = await awaitState(rpc, submitted.executionId, "WAITING_APPROVAL");
  assert.ok(pending.approval);
  const approval = { approvalId: pending.approval.approvalId, expectedDecisionVersion: pending.approval.decisionVersion, decision: "APPROVE" };
  await operator.call("operator_decide", approval);
  const result = await awaitState(rpc, submitted.executionId, "SUCCEEDED");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "output.txt"), "utf8"), "approved\n");
  type EventPage = { events: { sequence: number }[]; nextSequence: number };
  const firstEventPage = await rpc.call("execution_events", { id: result.executionId, afterSequence: 0, limit: 1 }) as EventPage;
  assert.equal(firstEventPage.events.length, 1);
  const reconnectedRpc = createRpcClient({ url: application.endpoint, token: token.trim() });
  const resumedEventPage = await reconnectedRpc.call("execution_events", { id: result.executionId, afterSequence: firstEventPage.nextSequence, limit: 100 }) as EventPage;
  assert.ok(resumedEventPage.events.length > 0);
  assert.ok(resumedEventPage.events.every(event => event.sequence > firstEventPage.nextSequence));
  const operatorTerminal = await operator.call("operator_inspect", { id: result.executionId }) as { run: RunView };
  assert.equal(operatorTerminal.run.state, result.state);
  assert.equal(operatorTerminal.run.stateVersion, result.stateVersion);
  assert.deepEqual(operatorTerminal.run.result, result.result);
  assert.equal((await rpc.call("execution_submit", input) as RunView).executionId, result.executionId);
  assert.ok("error" in (await operator.call("operator_decide", approval) as object));

  const command = { capability: "process_run", input: { executable: process.execPath, args: ["-e", "require('node:fs').appendFileSync('process-output.txt','once\\n'); process.stdout.write('process verified\\n')"] }, idempotencyKey: randomUUID() };
  const processRun = await rpc.call("execution_submit", command) as RunView;
  const processApproval = await awaitState(rpc, processRun.executionId, "WAITING_APPROVAL");
  assert.equal(await fs.stat(path.join(fixture.workspace, "process-output.txt")).then(() => true, () => false), false);
  await operator.call("operator_decide", { approvalId: processApproval.approval!.approvalId, expectedDecisionVersion: processApproval.approval!.decisionVersion, decision: "APPROVE" });
  await awaitState(rpc, processRun.executionId, "SUCCEEDED");
  assert.equal((await rpc.call("execution_submit", command) as RunView).executionId, processRun.executionId);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "process-output.txt"), "utf8"), "once\n");
  const processOutput = await rpc.call("execution_process_output", { id: processRun.executionId, stream: "stdout", offset: 0, limit: 8 }) as { dataBase64: string; nextOffset: number };
  assert.equal(Buffer.from(processOutput.dataBase64, "base64").toString(), "process ");
  assert.equal(processOutput.nextOffset, 8);

  // Revalidation after approval detects an external change to the expected file content.
  const guarded = await rpc.call("execution_submit", { capability: "fs_write", input: {
    path: "input.txt", content: "must-not-overwrite", expectedSha256: createHash("sha256").update("before\n").digest("hex")
  }, idempotencyKey: randomUUID() }) as RunView;
  const guardedPending = await awaitState(rpc, guarded.executionId, "WAITING_APPROVAL");
  await fs.writeFile(path.join(fixture.workspace, "input.txt"), "changed externally\n");
  await operator.call("operator_decide", { approvalId: guardedPending.approval!.approvalId, expectedDecisionVersion: guardedPending.approval!.decisionVersion, decision: "APPROVE" });
  await awaitState(rpc, guarded.executionId, "FAILED");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "input.txt"), "utf8"), "changed externally\n");

  // Retarget a formerly ordinary directory after approval was requested.
  const lexical = path.join(fixture.workspace, "pending-directory");
  const alternate = path.join(fixture.workspace, "alternate-directory");
  await fs.mkdir(lexical); await fs.mkdir(alternate);
  const linked = await rpc.call("execution_submit", { capability: "fs_write", input: {
    path: "pending-directory/target.txt", content: "must-not-follow", expectedSha256: null
  }, idempotencyKey: randomUUID() }) as RunView;
  const linkedPending = await awaitState(rpc, linked.executionId, "WAITING_APPROVAL");
  await fs.rmdir(lexical);
  await fs.symlink(alternate, lexical, process.platform === "win32" ? "junction" : "dir");
  await operator.call("operator_decide", { approvalId: linkedPending.approval!.approvalId, expectedDecisionVersion: linkedPending.approval!.decisionVersion, decision: "APPROVE" });
  await awaitState(rpc, linked.executionId, "FAILED");
  assert.equal(await fs.stat(path.join(alternate, "target.txt")).then(() => true, () => false), false);
  await fs.unlink(lexical);

  // Actual MCP client/Edge reaches this same resident application, not a mocked dispatcher.
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "v3-edge.js");
  edge = new Client({ name: "v3-application-test", version: "1" });
  await edge.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    P05_V3_ENDPOINT: application.endpoint, P05_V3_CLIENT_TOKEN_FILE: application.clientTokenFile
  }, stderr: "pipe" }));
  const reply = await edge.callTool({ name: "execution_status", arguments: { id: submitted.executionId } });
  const edgeRun = reply.structuredContent as RunView;
  assert.equal(edgeRun.state, "SUCCEEDED");
  assert.equal(edgeRun.state, operatorTerminal.run.state);
  assert.equal(edgeRun.stateVersion, operatorTerminal.run.stateVersion);
  assert.deepEqual(edgeRun.result, operatorTerminal.run.result);
  await edge.close(); edge = undefined;
  assert.equal((await rpc.call("core_status", {}) as { liveness: boolean }).liveness, true);

  // Changing the local authority revision does not retarget/re-authorize an already queued intent.
  const revoked = await rpc.call("execution_submit", { capability: "fs_write", input: { path: "revoked.txt", content: "no", expectedSha256: null }, idempotencyKey: randomUUID() }) as RunView;
  const revocationPending = await awaitState(rpc, revoked.executionId, "WAITING_APPROVAL");
  await fs.writeFile(configFile, JSON.stringify({ ...config, authorizationRevision: "test-policy-2", allowWrites: false }));
  await operator.call("operator_decide", { approvalId: revocationPending.approval!.approvalId, expectedDecisionVersion: revocationPending.approval!.decisionVersion, decision: "APPROVE" });
  await awaitState(rpc, revoked.executionId, "DENIED");
  assert.equal(await fs.stat(path.join(fixture.workspace, "revoked.txt")).then(() => true, () => false), false);
  await application.close();
  await fs.writeFile(workflowCatalog, "{broken optional catalog");
  application = await startV3Application(configFile);
  rpc = createRpcClient({ url: application.endpoint, token: token.trim() });
  assert.equal(application.status().workflow.available, false);
  assert.equal(application.status().mode, "DEGRADED");
  assert.equal((await rpc.call("core_status", {}) as { liveness: boolean }).liveness, true);
  assert.equal((await rpc.call("workflow_list", {}) as { error: { code: string } }).error.code, "DEPENDENCY_UNAVAILABLE");
  const degradedRead = await rpc.call("execution_submit", { capability: "fs_read", input: { path: "output.txt" }, idempotencyKey: randomUUID() }) as RunView;
  await awaitState(rpc, degradedRead.executionId, "SUCCEEDED");
  operator = createRpcClient({ url: application.endpoint, token: (await fs.readFile(application.operatorTokenFile, "utf8")).trim() });
  const detached = await rpc.call("execution_submit", { capability: "process_run", input: { executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('detach-started.txt','started'); setTimeout(()=>{require('node:fs').writeFileSync('detach-completed.txt','completed')},5000)"] }, idempotencyKey: randomUUID() }) as RunView;
  const detachedApproval = await awaitState(rpc, detached.executionId, "WAITING_APPROVAL");
  await operator.call("operator_decide", { approvalId: detachedApproval.approval!.approvalId, expectedDecisionVersion: detachedApproval.approval!.decisionVersion, decision: "APPROVE" });
  const startedDeadline = Date.now() + 10000;
  while (!await fs.stat(path.join(fixture.workspace, "detach-started.txt")).then(() => true, () => false)) {
    assert.ok(Date.now() < startedDeadline); await new Promise(resolve => setTimeout(resolve, 25));
  }
  await application.close();
  application = await startV3Application(configFile);
  rpc = createRpcClient({ url: application.endpoint, token: token.trim() });
  assert.equal((await rpc.call("execution_status", { id: detached.executionId }) as RunView).state, "UNKNOWN");
  const detachedDeadline = Date.now() + 10000;
  for (;;) {
    const hostView = await rpc.call("execution_process_status", { id: detached.executionId }) as { state: string; receipt?: { cancelRequested: boolean } };
    if (hostView.state === "EXITED") { assert.equal(hostView.receipt!.cancelRequested, false); break; }
    assert.ok(Date.now() < detachedDeadline); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await fs.readFile(path.join(fixture.workspace, "detach-completed.txt"), "utf8"), "completed");
  console.log("V3_APPLICATION_OK (real ACL, SQLite restart, original approval resume, exact intent, CAS, MCP Edge, Git bridge, HostExecute approval/output, three-stage workflow restart, link retarget refusal, revocation)");
} finally {
  await edge?.close();
  await application?.close();
  await processServer.close();
  await processHost.close();
  await fixture.remove();
}
