import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const fixture = path.join(repo, "_p05_v3_t42_plugin_controller");
const stateDir = path.join(fixture, "runtime-a-state");
const workspace = path.join(fixture, "workspace");
const serverEntry = path.resolve(here, "..", "index.js");
await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(workspace, { recursive: true });

type PluginView = {
  id: string;
  desired: "enabled" | "disabled";
  manualHold: boolean;
  controllerRevision: number;
  state: string;
  observed: string;
};
type BridgeMeta = { url: string; token: string; pid: number };

function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_") && !key.startsWith("MATLAB_") &&
        key !== "REMOTE_AGENT_ALLOWED_ROOTS" && key !== "REMOTE_AGENT_DEFAULT_CWD") env[key] = value;
  }
  return {
    ...env,
    REMOTE_AGENT_ALLOWED_ROOTS: fixture,
    REMOTE_AGENT_DEFAULT_CWD: workspace,
    P05_STATE_DIR: stateDir,
    P05_RUNTIME_SLOT: "A",
    P05_TOOL_PROFILE: "readonly",
    P05_EXAMPLE_PLUGIN_ENABLED: "true",
    MATLAB_MCP_ENABLED: "false"
  };
}

async function bridgeFiles(): Promise<Set<string>> {
  return new Set((await fs.readdir(stateDir).catch(() => []))
    .filter(name => name.startsWith("operator-bridge-") && name.endsWith(".json")));
}

async function latestBridge(previous: ReadonlySet<string>): Promise<BridgeMeta> {
  for (let i = 0; i < 500; i++) {
    const files = [...await bridgeFiles()].filter(name => !previous.has(name));
    for (const name of files) {
      try {
        const value = JSON.parse(await fs.readFile(path.join(stateDir, name), "utf8")) as BridgeMeta;
        if (name !== `operator-bridge-${value.pid}.json` || !value.url.startsWith("http://127.0.0.1:") || value.token.length !== 64) continue;
        const response = await fetch(value.url + "/api/overview", {
          headers: { authorization: `Bearer ${value.token}` },
          signal: AbortSignal.timeout(500)
        });
        if (response.status === 200) return value;
      } catch { /* incomplete or not-yet-live metadata */ }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("T42_OPERATOR_BRIDGE_TIMEOUT");
}

async function request(meta: BridgeMeta, pathname: string, method = "GET") {
  const response = await fetch(meta.url + pathname, {
    method,
    headers: { authorization: `Bearer ${meta.token}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {})
  });
  const body = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function plugin(meta: BridgeMeta): Promise<PluginView> {
  const body = await request(meta, "/api/overview") as { plugins: PluginView[] };
  const view = body.plugins.find(item => item.id === "example");
  assert.ok(view, "example plugin must be visible");
  return view;
}

async function launch() {
  const previous = await bridgeFiles();
  const client = new Client({ name: "t42-slot-restart", version: VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: environment(),
    stderr: "pipe"
  });
  await client.connect(transport);
  const meta = await latestBridge(previous);
  return { client, meta };
}

async function waitPlugin(meta: BridgeMeta, predicate: (view: PluginView) => boolean): Promise<PluginView> {
  for (let i = 0; i < 250; i++) {
    const view = await plugin(meta);
    if (predicate(view)) return view;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("T42_PLUGIN_STATE_TIMEOUT");
}

let runtime = await launch();
try {
  const initial = await waitPlugin(runtime.meta, view => view.state === "running");
  assert.equal(initial.desired, "enabled");
  assert.equal(initial.manualHold, false);
  assert.equal(initial.observed, "running");

  const stopped = (await request(runtime.meta, "/api/plugin/example/action/stop", "POST")).plugin as PluginView;
  assert.equal(stopped.desired, "enabled");
  assert.equal(stopped.manualHold, true);
  assert.equal(stopped.state, "stopped");
  const stopRevision = stopped.controllerRevision;

  await runtime.client.close();
  runtime = await launch();
  const heldAfterRestart = await waitPlugin(runtime.meta, view => view.state === "stopped");
  assert.equal(heldAfterRestart.desired, "enabled");
  assert.equal(heldAfterRestart.manualHold, true);
  assert.ok(heldAfterRestart.controllerRevision >= stopRevision);

  const blockedCall = await runtime.client.callTool({ name: "example.echo", arguments: { message: "must-not-run" } });
  assert.equal(blockedCall.isError, true);
  assert.match(JSON.stringify(blockedCall), /not enabled for workspace|Plugin \\"example\\"/);

  const resumed = (await request(runtime.meta, "/api/plugin/example/action/start", "POST")).plugin as PluginView;
  assert.equal(resumed.state, "running");
  assert.equal(resumed.manualHold, false);
  const resumeRevision = resumed.controllerRevision;

  await runtime.client.close();
  runtime = await launch();
  const runningAfterRestart = await waitPlugin(runtime.meta, view => view.state === "running");
  assert.equal(runningAfterRestart.manualHold, false);
  assert.ok(runningAfterRestart.controllerRevision >= resumeRevision);

  const restarted = (await request(runtime.meta, "/api/plugin/example/action/restart", "POST")).plugin as PluginView;
  assert.equal(restarted.state, "running");
  assert.equal(restarted.manualHold, false);
  assert.ok(restarted.controllerRevision > runningAfterRestart.controllerRevision);

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, "plugin-controller.json"), "utf8")) as {
    version: number;
    plugins: Record<string, { desired: string; manualHold: boolean; observed: string; revision: number }>;
  };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.plugins.example?.desired, "enabled");
  assert.equal(persisted.plugins.example?.manualHold, false);
  assert.equal(persisted.plugins.example?.observed, "running");

  console.log("V3_T42_PLUGIN_CONTROLLER_OK (manual stop persists across Slot/Core restart, reconciler respects hold, start clears hold, restart stays enabled)");
} finally {
  await runtime.client.close().catch(() => undefined);
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}
