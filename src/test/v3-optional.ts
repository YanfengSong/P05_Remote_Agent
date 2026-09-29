import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { V2OptionalHost, createOptionalEnvironment, type OptionalHostOptions, type OptionalCallView } from "../v3/optional/v2-host.js";
import { createRpcClient, startRpcServer } from "../v3/transport/rpc.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p05-v3-optional-"));
const workspace = path.join(fixtureRoot, "workspace");
const outside = path.join(fixtureRoot, "outside");
const stateDir = path.join(fixtureRoot, "state");
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, "inside.txt"), "bound workspace content");
fs.writeFileSync(path.join(outside, "outside.txt"), "must stay outside");
const options: OptionalHostOptions = {
  nodeExecutable: process.execPath,
  entrypoint: fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
  workspaceRoot: workspace, stateDir, slot: "B", profile: "readonly"
};
const host = new V2OptionalHost(options);
const clientToken = randomBytes(32).toString("hex");
const core = await startRpcServer({ clientToken, operatorToken: randomBytes(32).toString("hex"), async handle() { return { alive: true }; } });
const coreClient = createRpcClient({ url: core.url, token: clientToken });
const hosts: V2OptionalHost[] = [host];

async function completed(target: V2OptionalHost, call: Promise<OptionalCallView>): Promise<OptionalCallView> {
  let result = await call;
  for (let index = 0; index < 200 && result.state === "pending"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = target.callStatus(result.callId)!;
  }
  assert.equal(result.state, "completed", JSON.stringify(result));
  return result;
}

try {
  const stripped = createOptionalEnvironment({ ...options, environmentAllowlist: ["MATLAB_MCP_ENABLED"] }, {
    PATH: "system-path", P05_V3_OPERATOR_TOKEN: "secret", P05_OTHER_SECRET: "secret", MATLAB_LICENSE_SECRET: "secret",
    NODE_OPTIONS: "--require evil.js", MATLAB_MCP_ENABLED: "false"
  });
  assert.equal(stripped.P05_V3_OPERATOR_TOKEN, undefined);
  assert.equal(stripped.P05_OTHER_SECRET, undefined);
  assert.equal(stripped.MATLAB_LICENSE_SECRET, undefined);
  assert.equal(stripped.NODE_OPTIONS, undefined);
  assert.equal(stripped.MATLAB_MCP_ENABLED, "false");
  assert.equal(stripped.REMOTE_AGENT_ALLOWED_ROOTS, workspace);
  assert.throws(() => createOptionalEnvironment({ ...options, environmentAllowlist: ["p05_v3_operator_token"] }), /protected key/);
  assert.throws(() => createOptionalEnvironment({ ...options, environment: { MATLAB_MCP_ENABLED: "true" } }), /allowlisted/);

  // Caller-owned configuration mutations cannot retarget this already-created host.
  options.workspaceRoot = outside;
  const ready = await host.start();
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  const generation = ready.generation;
  assert.ok(generation);
  assert.ok((await host.listTools()).some((tool) => tool.tool === "fs_read"));
  const ping = await completed(host, host.call("ping", {}));
  assert.notEqual(ping.result?.isError, true);
  const read = await completed(host, host.call("fs_read", { path: "inside.txt" }));
  assert.notEqual(read.result?.isError, true);
  assert.match(JSON.stringify(read.result), /bound workspace content/);
  const refused = await completed(host, host.call("fs_read", { path: path.join(outside, "outside.txt"), workspaceRoot: outside }));
  assert.equal(refused.result?.isError, true);
  await assert.rejects(host.call("workspace_switch", { root: outside }), /CAPABILITY_UNAVAILABLE/);
  await assert.rejects(host.call("shell_run", { command: "Write-Output hello" }), /CAPABILITY_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(stateDir, "audit.json")), false);
  assert.ok(fs.existsSync(path.join(stateDir, "optional-v2", "B", generation, "audit.json")));
  await host.close();
  assert.equal(host.health().state, "stopped");
  assert.deepEqual(await coreClient.call("core_status", {}), { alive: true });
  assert.equal((await host.start()).state, "ready");
  assert.notEqual(host.health().generation, generation);
  await host.close();

  const broken = new V2OptionalHost({ ...options, workspaceRoot: workspace, entrypoint: path.join(fixtureRoot, "missing-entry.mjs") });
  hosts.push(broken);
  const degraded = await broken.start();
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.lastError, "HOST_START_FAILED");
  assert.equal(JSON.stringify(degraded).includes(fixtureRoot), false);
  assert.deepEqual(await coreClient.call("core_status", {}), { alive: true });

  // Exercise a true MCP child with a slow handler to prove wait != cancellation.
  const slowEntry = path.join(fixtureRoot, "slow-host.mjs");
  fs.writeFileSync(slowEntry, `
    import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
    import { serveStdio } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
    import * as z from ${JSON.stringify(import.meta.resolve("zod/v4"))};
    serveStdio(() => {
      const server = new McpServer({ name: "slow-test-host", version: "1" });
      server.registerTool("workspace_current", { inputSchema: z.object({}) }, async () => ({ content: [], structuredContent: { id: "v3-bound" } }));
      server.registerTool("fs_read", { inputSchema: z.object({ crash: z.boolean().optional() }) }, async ({ crash }) => {
        if (crash) process.exit(17);
        await new Promise(resolve => setTimeout(resolve, 250));
        return { content: [{ type: "text", text: "eventually-completed" }], structuredContent: { done: true } };
      });
      return server;
    });
  `);
  const slow = new V2OptionalHost({ ...options, workspaceRoot: workspace, entrypoint: slowEntry });
  hosts.push(slow);
  assert.equal((await slow.start()).state, "ready");
  const pending = await slow.call("fs_read", {}, { waitMs: 1 });
  assert.equal(pending.state, "pending");
  const eventual = await completed(slow, Promise.resolve(pending));
  assert.equal(eventual.callId, pending.callId);
  assert.equal(eventual.generation, pending.generation);
  assert.match(JSON.stringify(eventual.result), /eventually-completed/);
  const crashed = await slow.call("fs_read", { crash: true }, { waitMs: 1000 });
  assert.equal(crashed.state, "unknown");
  for (let index = 0; index < 50 && slow.health().state !== "degraded"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(slow.health().state, "degraded");
  assert.deepEqual(await coreClient.call("core_status", {}), { alive: true }, "a real Optional Host crash cannot kill Core");

  const confirming = new V2OptionalHost({
    ...options, workspaceRoot: workspace, profile: "developer", capabilities: { shell_run: "shell_run" }
  });
  hosts.push(confirming);
  assert.equal((await confirming.start()).state, "ready");
  const approval = await completed(confirming, confirming.call("shell_run", { command: "python nonexistent-test.py" }));
  assert.equal(approval.result?.isError, true);
  assert.equal(approval.approval?.state, "approval_required");
  assert.match(approval.approval?.approvalId ?? "", /^[a-f0-9-]{36}$/);
  console.log("V3_OPTIONAL_OK (real V2 readonly, fixed workspace, traversal refusal, isolated state/lifecycle, startup/crash degradation, wait semantics, V2 approval preserved)");
} finally {
  await Promise.all(hosts.map((target) => target.close()));
  await core.close();
  assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith("p05-v3-optional-"));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
