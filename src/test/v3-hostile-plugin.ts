import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRpcClient, type RpcClient } from "../v3/transport/rpc.js";
import type { ComponentHostConfig } from "../v3/component-host/contracts.js";
import { preparePermissionIsolatedComponentHost } from "../v3/component-host/permissions.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";

const fixture = await createPrivateV3Fixture();
const children: ChildProcess[] = [];
const hostFile = fileURLToPath(new URL("../v3-component-host.js", import.meta.url));
const runtimeRoot = path.dirname(path.dirname(hostFile));
const installed = path.join(fixture.state, "hostile-installed");
const stateDir = path.join(fixture.state, "hostile-state");
const configFile = path.join(fixture.state, "hostile-config.json");
const foreignSlot = path.join(fixture.root, "foreign-slot");
fs.mkdirSync(installed, { mode: 0o700 });
fs.mkdirSync(stateDir, { mode: 0o700 });
fs.mkdirSync(foreignSlot, { mode: 0o700 });
const ownFile = path.join(fixture.workspace, "own.txt");
const foreignFile = path.join(foreignSlot, "foreign.txt");
fs.writeFileSync(ownFile, "own-slot-data", { mode: 0o600 });
fs.writeFileSync(foreignFile, "FOREIGN-SLOT-SECRET", { mode: 0o600 });

const key = { name: "hostile.read", version: "1" };
const source = [
  "import fs from 'node:fs';",
  "import { execFileSync } from 'node:child_process';",
  "export function createComponent({z}) { return {",
  " configSchema:z.object({}).strict(),",
  " activate(ctx) {",
  "  ctx.provide(" + JSON.stringify(key) + ", {",
  "   inputSchema:z.object({mode:z.enum(['read','huge','spawn','ok']),path:z.string().max(4096).optional()}).strict(),",
  "   async invoke(input,owner) {",
  "    if(input.mode==='huge') return {text:'X'.repeat(2*1024*1024)};",
  "    if(input.mode==='spawn') { try { execFileSync(process.execPath,['-e','process.exit(0)']); return {spawned:true}; } catch(error) { return {denied:error && typeof error==='object' && 'code' in error ? error.code : 'UNKNOWN'}; } }",
  "    if(input.mode==='read') {",
  "      try { return {value:fs.readFileSync(input.path,'utf8'),slotId:owner.slotId}; }",
  "      catch(error) { return {denied:error && typeof error==='object' && 'code' in error ? error.code : 'UNKNOWN',slotId:owner.slotId}; }",
  "    }",
  "    return {value:'ok',slotId:owner.slotId};",
  "   }",
  "  });",
  " }",
  "};}"
].join("\n");
const moduleFile = path.join(installed, "hostile.mjs");
fs.writeFileSync(moduleFile, source, { mode: 0o600 });
const digest = createHash("sha256").update(source).digest("hex");
const config: ComponentHostConfig = {
  version: 1,
  slotId: "slot-A",
  principalId: "hostile-test",
  workspaceRoot: fixture.workspace,
  isolationMode: "node-permission",
  maxResultBytes: 4096,
  stateDir,
  installationRoot: installed,
  port: 0,
  installations: [{
    installationId: "hostile-v1",
    file: moduleFile,
    manifest: {
      componentId: "hostile",
      revision: "1",
      entrypointDigest: digest,
      configVersion: "1",
      scope: "workspace",
      hostCompatibility: ["win32", "linux", "darwin"],
      provides: [{ key, kind: "single" }],
      requires: [],
      effectOwnership: [],
      activationPolicy: "desired"
    }
  }],
  components: [{ componentId: "hostile", installationId: "hostile-v1", config: {} }],
  capabilities: [{ capabilityId: "hostile-read", componentId: "hostile", key, effect: "E0", description: "Hostile fixture capability" }],
  assets: []
};
fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });

type Ready = {
  event: string;
  endpoint?: string;
  clientTokenFile?: string;
  operatorTokenFile?: string;
  code?: string;
  isolationEnforced?: boolean;
  securityMode?: string;
};

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function launch(label: string, execArgv: string[], preflightDigest?: string): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = fork(hostFile, [], {
    execArgv,
    env: { ...process.env, P05_V3_COMPONENT_CONFIG: configFile, ...(preflightDigest ? { P05_V3_COMPONENT_PERMISSION_PREFLIGHT: preflightDigest } : {}) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true
  });
  children.push(child);
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("T25_HOST_START_TIMEOUT")), 20_000);
    let output = "";
    let resolved = false;
    child.stderr!.on("data", (bytes) => {
      output += bytes.toString();
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Ready;
          if (message.event?.startsWith("p05.v3.component.")) {
            resolved = true;
            clearTimeout(timer);
            resolve(message);
            return;
          }
        } catch { /* permission diagnostics are not protocol messages */ }
      }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { if (!resolved) { clearTimeout(timer); reject(new Error("T25_HOST_EXIT_BEFORE_STATUS:" + label + ":" + code + ":" + signal + ":" + output)); } });
  });
  return { child, ready };
}
function client(ready: Ready): RpcClient {
  assert.ok(ready.endpoint && ready.clientTokenFile);
  return createRpcClient({ url: ready.endpoint, token: fs.readFileSync(ready.clientTokenFile, "utf8").trim(), timeoutMs: 10_000, maxResponseBytes: 64 * 1024 });
}

try {
  const noPreflight = await launch("no-preflight", []);
  assert.equal(noPreflight.ready.event, "p05.v3.component.start_failed");
  assert.equal(noPreflight.ready.code, "COMPONENT_PERMISSION_PREFLIGHT_REQUIRED", "permission-isolated Host requires trusted ACL preflight");
  await kill(noPreflight.child);

  const prepared = await preparePermissionIsolatedComponentHost({ configFile, runtimeRoot });
  const withoutPermission = await launch("without-permission", [], prepared.preflightDigest);
  assert.equal(withoutPermission.ready.event, "p05.v3.component.start_failed");
  assert.equal(withoutPermission.ready.code, "COMPONENT_PERMISSION_ISOLATION_REQUIRED", "trusted preflight alone cannot replace the Node permission system");
  await kill(withoutPermission.child);

  const isolated = await launch("isolated", prepared.execArgv, prepared.preflightDigest);
  assert.equal(isolated.ready.event, "p05.v3.component.ready", JSON.stringify(isolated.ready));
  assert.equal(isolated.ready.isolationEnforced, true);
  assert.equal(isolated.ready.securityMode, "node-permission");
  const rpc = client(isolated.ready);

  const status = await rpc.call("component_status", {}) as any;
  assert.equal(status.isolationEnforced, true);
  assert.equal(status.securityMode, "node-permission");
  assert.equal(status.slotId, "slot-A");

  const own = await rpc.call("component_call", { capabilityId: "hostile-read", input: { mode: "read", path: ownFile } }) as any;
  assert.equal(own.result.value, "own-slot-data");
  assert.equal(own.result.slotId, "slot-A");

  const foreign = await rpc.call("component_call", { capabilityId: "hostile-read", input: { mode: "read", path: foreignFile } }) as any;
  assert.equal(foreign.result.value, undefined);
  assert.equal(foreign.result.denied, "ERR_ACCESS_DENIED", "hostile plugin cannot read another Slot outside its permission root");
  assert.equal(JSON.stringify(foreign).includes("FOREIGN-SLOT-SECRET"), false);

  const spawnBypass = await rpc.call("component_call", { capabilityId: "hostile-read", input: { mode: "spawn" } }) as any;
  assert.equal(spawnBypass.result.spawned, undefined);
  assert.equal(spawnBypass.result.denied, "ERR_ACCESS_DENIED", "isolated plugin cannot spawn a child process to bypass Slot filesystem permissions");

  for (let i = 0; i < 4; i++) {
    const huge = await rpc.call("component_call", { capabilityId: "hostile-read", input: { mode: "huge" } }) as any;
    assert.equal(huge.error.code, "COMPONENT_OUTPUT_LIMIT_EXCEEDED", "oversized hostile output is rejected before RPC serialization");
    assert.ok(JSON.stringify(huge).length < 1024);
  }

  const healthy = await rpc.call("component_call", { capabilityId: "hostile-read", input: { mode: "ok" } }) as any;
  assert.equal(healthy.result.value, "ok", "Host remains usable after repeated oversized-output attempts");
  assert.equal(healthy.result.slotId, "slot-A");

  console.log("V3_T25_HOSTILE_PLUGIN_OK (permission-isolated Slot filesystem, foreign read and child-process bypass denied, bounded hostile results, Host survives output flood; existing component-host covers crash/infinite-loop Core isolation)");
} finally {
  for (const child of children) await kill(child).catch(() => undefined);
  await fixture.remove();
}