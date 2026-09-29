import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRpcClient, type RpcClient } from "../v3/transport/rpc.js";
import { CoreState } from "../v3/core/state.js";
import type { ComponentHostConfig } from "../v3/component-host/contracts.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";

const fixture = await createPrivateV3Fixture();
const children: ChildProcess[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let checks = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hostFile = fileURLToPath(new URL("../v3-component-host.js", import.meta.url));
const installed = path.join(fixture.state, "installed");
const stateDir = path.join(fixture.state, "host-state");
fs.mkdirSync(installed, { mode: 0o700 }); fs.mkdirSync(stateDir, { mode: 0o700 });
const configFile = path.join(fixture.state, "host-config.json");
const disposed = path.join(fixture.state, "disposed.txt");
const began = path.join(fixture.state, "began.txt");
const releaseFile = path.join(fixture.state, "release-call");
const key = { name: "demo.read", version: "1" };
function moduleSource(label: string) {
  return `import fs from 'node:fs';
export function createComponent({z}) { return {
 configSchema:z.object({prefix:z.string(),disposeFile:z.string(),beginFile:z.string(),releaseFile:z.string(),failActivation:z.boolean().default(false)}).strict(),
 activate(ctx,config) {
  if(config.failActivation) throw new Error('PRIVATE_ACTIVATION_DETAIL');
  ctx.onDispose(()=>fs.appendFileSync(config.disposeFile,${JSON.stringify(label)}+'\\n'));
  ctx.provide(${JSON.stringify(key)},{inputSchema:z.object({delayMs:z.number().int().min(0).max(2000).default(0),held:z.boolean().default(false),external:z.boolean().default(false),block:z.boolean().default(false)}).strict(),
   async invoke(input,owner) {
    fs.appendFileSync(config.beginFile,${JSON.stringify(label)}+'\\n');
    if(input.block) { while(true) {} }
    if(input.external) return ctx.external('E2','missing-core-gateway','external-test',{});
    while(input.held && !fs.existsSync(config.releaseFile)) await new Promise(resolve=>setTimeout(resolve,5));
    await new Promise(resolve=>setTimeout(resolve,input.delayMs));
    return {value:config.prefix+${JSON.stringify(label)},owner};
   }
  });
 }
};}
`;
}
const installations: ComponentHostConfig["installations"] = ["v1", "v2"].map((revision) => {
  const source = moduleSource(revision); const file = path.join(installed, `${revision}.mjs`); fs.writeFileSync(file, source, { mode: 0o600 });
  return { installationId: revision, file, manifest: { componentId: "demo", revision, entrypointDigest: hash(source), configVersion: "1", scope: "workspace", hostCompatibility: ["win32", "linux", "darwin"], provides: [{ key, kind: "single" }], requires: [], effectOwnership: [{ effect: "E1", management: "fiber" }, { effect: "E2", management: "external", manager: "missing-core-gateway" }], activationPolicy: "desired" } };
});
const assetFile = path.join(installed, "asset.txt"); fs.writeFileSync(assetFile, "reviewed local asset", { mode: 0o600 });
const componentConfig = { prefix: "initial-", disposeFile: disposed, beginFile: began, releaseFile };
const config: ComponentHostConfig = {
  version: 1, slotId: "slot-A", principalId: "local-operator", workspaceRoot: fixture.workspace, stateDir, installationRoot: installed, port: 0,
  installations, components: [{ componentId: "demo", installationId: "v1", config: componentConfig }],
  capabilities: [{ capabilityId: "demo-read", componentId: "demo", key, effect: "E0", description: "Read a configured in-memory greeting" }],
  assets: [{ assetId: "guide", revision: "1", file: assetFile, digest: hash(fs.readFileSync(assetFile)), evidenceRef: "operator-review:test", operatorReviewed: true, effects: ["E0"] }],
};
const writeConfig = (value = config) => fs.writeFileSync(configFile, JSON.stringify(value), { mode: 0o600 });
writeConfig();
type Ready = { event: string; endpoint: string; clientTokenFile: string; operatorTokenFile: string; code?: string; bindingDigest: string };
async function launch() {
  const child = fork(hostFile, [], { env: { ...process.env, P05_V3_COMPONENT_CONFIG: configFile }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true }); children.push(child);
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("COMPONENT_CHILD_START_TIMEOUT")), 20_000);
    let output = "";
    child.stderr!.on("data", (bytes) => {
      output += bytes.toString(); const lines = output.split("\n"); output = lines.pop() ?? "";
      for (const line of lines) { try { const message = JSON.parse(line) as Ready; if (message.event?.startsWith("p05.v3.component.")) { clearTimeout(timer); resolve(message); } } catch { /* Node diagnostic, no secrets printed. */ } }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("COMPONENT_CHILD_EXIT_BEFORE_STATUS")); });
  });
  return { child, ready };
}
async function kill(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
function clients(ready: Ready) {
  return { client: createRpcClient({ url: ready.endpoint, token: fs.readFileSync(ready.clientTokenFile, "utf8").trim(), timeoutMs: 15000 }),
    operator: createRpcClient({ url: ready.endpoint, token: fs.readFileSync(ready.operatorTokenFile, "utf8").trim(), timeoutMs: 15000 }) };
}
async function request(client: RpcClient, method: string, input: unknown = {}): Promise<any> { return client.call(method, input); }
let core: CoreState | undefined;
try {
  const first = await launch(); check(first.ready.event === "p05.v3.component.ready", "real private-ACL standalone Host starts");
  const { client, operator } = clients(first.ready);
  const status = await request(client, "component_status");
  check(status.slotId === "slot-A" && status.principalId === "local-operator" && status.isolationEnforced === false && !status.externalGatewayAvailable, "authenticated metadata fixes owner and honestly denies OS sandbox/gateway");
  check(status.capabilities[0].effect === "E0" && status.bindingDigest === first.ready.bindingDigest, "Core bridge receives immutable capability effect and binding digest");
  const initial = await request(client, "component_call", { capabilityId: "demo-read", input: {}, runId: "audit-only" });
  check(initial.result.value === "initial-v1" && initial.result.owner.runId === "audit-only" && initial.result.owner.slotId === "slot-A", "declared service invokes with server-controlled owner and audit-only run ID");
  check((await request(client, "component_call", { capabilityId: "demo-read", input: {}, slotId: "slot-B", effect: "E0" })).error.code === "INVALID_COMPONENT_ARGUMENT", "client cannot spoof Slot or effect");
  check((await request(client, "component_call", { capabilityId: "undeclared", input: {} })).error.code === "COMPONENT_CAPABILITY_DENIED", "undeclared services are unreachable");
  check((await request(client, "component_replace", { componentId: "demo", installationId: "v2", config: componentConfig, expectedRevision: 1 })).error.code === "COMPONENT_OPERATOR_REQUIRED", "client cannot replace code");
  check((await request(client, "component_call", { capabilityId: "demo-read", input: { external: true } })).error.code === "EXTERNAL_EFFECT_MANAGER_UNAVAILABLE", "E2 request is rejected without Core-controlled gateway");
  check((await request(client, "asset_activate", { assetId: "guide", revision: "1", expectedDigest: config.assets[0].digest })).error.code === "COMPONENT_OPERATOR_REQUIRED", "client cannot activate assets");
  check((await request(operator, "asset_activate", { assetId: "guide", revision: "1", expectedDigest: config.assets[0].digest })).state === "ACTIVE", "operator activates exact locally reviewed asset digest");
  const contender = await launch(); check(contender.ready.code === "COMPONENT_HOST_ALREADY_OWNED", "OS-backed ownership lock rejects second process"); await kill(contender.child);

  const beforeCount = fs.readFileSync(began, "utf8").split("\n").length;
  const oldCall = request(client, "component_call", { capabilityId: "demo-read", input: { held: true } });
  const deadline = Date.now() + 2000;
  while (fs.readFileSync(began, "utf8").split("\n").length === beforeCount) { if (Date.now() > deadline) throw new Error("CALL_NOT_STARTED"); await sleep(5); }
  const replacement = await request(operator, "component_replace", { componentId: "demo", installationId: "v2", config: { ...componentConfig, prefix: "changed-" }, expectedRevision: 1 });
  check(!!replacement.bindingId && replacement.previousBindingId === initial.bindingId, "operator replacement publishes a new binding");
  check((await request(operator, "component_drain", { bindingId: initial.bindingId, timeoutMs: 0 })).drained === false, "old binding remains pinned by in-flight IPC call");
  check(!fs.existsSync(disposed), "old E1 disposers wait for in-flight invocation");
  const newCall = await request(client, "component_call", { capabilityId: "demo-read", input: {} });
  check(newCall.result.value === "changed-v2" && newCall.bindingId !== initial.bindingId, "new calls resolve replacement config and provider");
  const startedBeforeStale = fs.readFileSync(began, "utf8");
  check((await request(client, "component_call", { capabilityId: "demo-read", input: {}, expectedBindingId: initial.bindingId })).error.code === "BINDING_CHANGED" && fs.readFileSync(began, "utf8") === startedBeforeStale, "stale binding rejects before invoking replacement service");
  check((await request(client, "component_status")).capabilities[0].bindingId === replacement.bindingId, "capability metadata exposes exact current binding for Core revalidation");
  fs.writeFileSync(releaseFile, "release", { mode: 0o600 });
  check((await oldCall).result.value === "initial-v1", "old in-flight invocation keeps old provider and config");
  check((await request(operator, "component_drain", { bindingId: initial.bindingId, timeoutMs: 1000 })).drained && fs.readFileSync(disposed, "utf8").includes("v1"), "old binding disposes after actual pin release");
  const failed = await request(operator, "component_replace", { componentId: "demo", installationId: "v1", config: { ...componentConfig, failActivation: true }, expectedRevision: 2 });
  check(failed.error.code === "COMPONENT_OPERATION_FAILED" && (await request(client, "component_call", { capabilityId: "demo-read", input: {} })).result.value === "changed-v2", "failed activation preserves current provider and redacts plugin exception");
  await kill(first.child);
  const second = await launch(); check(second.ready.event === "p05.v3.component.ready", "Host restarts after process termination without acquiring Core owner lock");
  const reopened = clients(second.ready);
  check((await request(reopened.client, "component_call", { capabilityId: "demo-read", input: {} })).result.value === "changed-v2", "persisted exact installation and applied config survive process restart");
  const held = await request(reopened.operator, "component_desired", { componentId: "demo", enabled: true, manualHold: true, expectedRevision: 2 });
  check(held.revision === 3 && (await request(reopened.client, "component_call", { capabilityId: "demo-read", input: {} })).error.code === "SERVICE_UNAVAILABLE", "operator manualHold blocks new resolutions");
  await kill(second.child);
  const third = await launch(); const again = clients(third.ready);
  check((await request(again.client, "component_call", { capabilityId: "demo-read", input: {} })).error.code === "SERVICE_UNAVAILABLE", "manualHold survives a real process restart");
  await request(again.operator, "component_desired", { componentId: "demo", enabled: true, manualHold: false, expectedRevision: 3 });
  core = CoreState.open({ stateDir: path.join(fixture.state, "separate-core"), slotId: "slot-A", workspaceRoots: [fixture.workspace] });
  const blocked = again.client.call("component_call", { capabilityId: "demo-read", input: { block: true } }, { timeoutMs: 150 });
  await assert.rejects(blocked, /WAIT_TIMEOUT/); checks++;
  check(core.probe(), "plugin infinite loop in Optional process does not block Core event loop or state probe");
  await kill(third.child);

  const badConfig = structuredClone(config); badConfig.installations[0].manifest.entrypointDigest = "0".repeat(64); writeConfig(badConfig);
  const badDigest = await launch(); check(badDigest.ready.code === "COMPONENT_INSTALLATION_DIGEST_MISMATCH" && core.probe(), "digest mismatch stops only Optional Host startup"); await kill(badDigest.child);
  const workspaceFile = path.join(fixture.workspace, "plugin.mjs"); fs.writeFileSync(workspaceFile, moduleSource("v1"));
  const workspaceConfig = structuredClone(config); workspaceConfig.installations[0].file = workspaceFile; writeConfig(workspaceConfig);
  const badPath = await launch(); check(badPath.ready.code === "COMPONENT_INSTALLATION_PATH_DENIED", "Workspace code cannot become an installed private component"); await kill(badPath.child);
  console.log(`V3 Component Host: ${checks} checks passed`);
} finally {
  for (const child of children) await kill(child);
  core?.close(); await fixture.remove();
}
