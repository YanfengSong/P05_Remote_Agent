import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentProvider } from "../agent/provider.js";
import { AgentRuntime } from "../agent/runtime.js";
import { WorkspaceIsolationManager } from "../isolation/manager.js";
import { PluginRegistry } from "../plugin/registry.js";
import { PluginRuntime } from "../plugin/runtime.js";
import { PLUGIN_API_VERSION, type ApplicationPlugin } from "../plugin/types.js";
import { LocalPowerShellDriver } from "../process/drivers/local-powershell.js";
import { ProcessRuntime } from "../process/runtime.js";
import { createExecutionContext } from "../runtime/context.js";
import { SessionManager } from "../session/manager.js";
import { referenceStdioProvider } from "../plugins/agents/reference/provider.js";
import { WorkspaceManager, parseWorkspaceRegistry } from "../workspace/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_agent_runtime_test");
const PLATFORM = path.join(FIXTURE, "platform");
const BUSINESS = path.join(FIXTURE, "business");
const ISO = path.join(FIXTURE, "isolations");
const SESSION_STATE = path.join(FIXTURE, "sessions.json");
const ISO_STATE = path.join(FIXTURE, "isolations.json");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

async function rejects(
  label: string,
  fn: () => Promise<unknown> | unknown,
  mustContain?: string
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, mustContain ? message.includes(mustContain) : true, message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected rejection`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(PLATFORM, { recursive: true });
await fs.mkdir(BUSINESS, { recursive: true });
await fs.mkdir(ISO, { recursive: true });

for (const dir of [PLATFORM, BUSINESS]) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "P05 Agent Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "p05-agent@example.invalid"], { cwd: dir });
  await fs.writeFile(path.join(dir, "base.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "base.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "pipe" });
}

const writeProvider: AgentProvider = {
  id: "write-test",
  label: "Write Isolation Test Provider",
  writeAccess: true,
  async start() { return { id: "write-handle" }; },
  async task() {},
  async status() { return { state: "running" }; },
  async output(_handle, _context, cursor) {
    return { events: [], nextCursor: cursor, truncated: false };
  },
  async stop() {}
};

const failingProvider: AgentProvider = {
  id: "failing-agent",
  label: "Failing Agent Provider",
  writeAccess: false,
  async start() { throw new Error("provider boom"); },
  async task() {},
  async status() { return { state: "failed" }; },
  async output(_handle, _context, cursor) {
    return { events: [], nextCursor: cursor, truncated: false };
  },
  async stop() {}
};

const testPlugin: ApplicationPlugin = {
  manifest: {
    id: "agent-test",
    label: "Agent Runtime Test Plugin",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: true,
    capabilities: [],
    permissions: { workspace: "active", hostEffects: "none" }
  },
  agentProviders: () => [referenceStdioProvider, writeProvider, failingProvider]
};

const workspaces = parseWorkspaceRegistry(JSON.stringify([
  { id: "platform", root: PLATFORM, kind: "platform-source", plugins: ["agent-test"] },
  { id: "business", root: BUSINESS, kind: "git-project", plugins: ["agent-test"] }
]), [FIXTURE], PLATFORM);
const workspaceManager = new WorkspaceManager(workspaces, "platform");
const pluginRegistry = new PluginRegistry([testPlugin]);
const pluginRuntime = new PluginRuntime(pluginRegistry, workspaceManager);
await pluginRuntime.startAll();

const sessions = new SessionManager(SESSION_STATE);
const processRuntime = new ProcessRuntime(
  sessions,
  new LocalPowerShellDriver(),
  () => createExecutionContext({
    workspace: workspaceManager.current(),
    actor: { type: "interactive", id: "agent-test-interactive" },
    profile: "developer"
  })
);
const isolation = new WorkspaceIsolationManager({
  statePath: ISO_STATE,
  isolationRoot: ISO,
  allowedRoots: [FIXTURE],
  workspaceRoots: () => workspaceManager.all().map((workspace) => workspace.root)
});
const runtime = new AgentRuntime({
  sessions,
  processRuntime,
  isolation,
  pluginRegistry,
  pluginRuntime,
  workspaceManager,
  profile: "developer"
});

try {
  const providers = runtime.providers();
  check("agent: reference provider is discoverable",
    providers.some((provider) => provider.id === "reference-stdio" && provider.activeForWorkspace)
  );
  check("agent: writing provider advertises write access",
    providers.some((provider) => provider.id === "write-test" && provider.writeAccess)
  );

  const reference = await runtime.start("reference-stdio");
  check("agent: reference session starts", reference.state === "running", JSON.stringify(reference));
  check("agent: reference session uses workspace isolation", reference.isolationKind === "workspace");

  await sleep(500);
  const ready = await runtime.output(reference.id, 0, 65536);
  check("agent: reference provider emits ready output",
    ready.events.some((event) => event.text.includes('"ready"')),
    JSON.stringify(ready)
  );

  await runtime.task(reference.id, "hello-agent");
  await sleep(500);
  const taskOutput = await runtime.output(reference.id, ready.nextCursor, 65536);
  check("agent: task reaches provider",
    taskOutput.events.some((event) => event.text.includes("hello-agent")),
    JSON.stringify(taskOutput)
  );
  check("agent: task count increments",
    (await runtime.status(reference.id)).taskCount === 1
  );

  workspaceManager.switch("business");
  await rejects(
    "agent: interactive control cannot cross active workspace",
    () => runtime.status(reference.id),
    'belongs to workspace "platform"'
  );
  workspaceManager.switch("platform");
  check("agent: switching back restores control without retargeting",
    (await runtime.status(reference.id)).workspaceId === "platform"
  );

  const stopped = await runtime.stop(reference.id, true);
  check("agent: reference provider stops cleanly", stopped.state === "completed", stopped.state);

  workspaceManager.switch("business");
  const writerA = await runtime.start("write-test");
  const writerB = await runtime.start("write-test");
  const writerARecord = sessions.get(writerA.id);
  const writerBRecord = sessions.get(writerB.id);
  check("agent: writing provider receives worktree isolation", writerA.isolationKind === "worktree");
  check("agent: second writing provider receives worktree isolation", writerB.isolationKind === "worktree");
  check("agent: concurrent writers have distinct roots",
    writerARecord.context.isolation?.root !== writerBRecord.context.isolation?.root
  );
  check("agent: isolated root differs from source workspace",
    writerARecord.context.isolation?.root !== BUSINESS
  );

  const writerAStop = await runtime.stop(writerA.id, false);
  const writerBStop = await runtime.stop(writerB.id, false);
  check("agent: clean writing isolation releases on stop", writerAStop.state === "completed");
  check("agent: second clean isolation releases on stop", writerBStop.state === "completed");

  await rejects(
    "agent: provider start failure is local",
    () => runtime.start("failing-agent"),
    "provider boom"
  );
  check("agent: core remains usable after provider failure", runtime.providers().length === 3);
  check("agent: failed provider session is recorded",
    runtime.sessions().some((session) => session.providerId === "failing-agent" && session.state === "failed")
  );

  const stateText = await fs.readFile(SESSION_STATE, "utf8");
  check("agent: session state persists metadata", stateText.includes("reference-stdio"));
  check("agent: task payload is not persisted", !stateText.includes("hello-agent"), stateText);

  console.log(`AGENT_RUNTIME_OK (${checks} checks)`);
} finally {
  workspaceManager.switch("platform");
  await runtime.interruptAll().catch(() => undefined);
  await processRuntime.interruptAll().catch(() => undefined);
  await pluginRuntime.stopAll().catch(() => undefined);
  execFileSync("git", ["worktree", "prune"], { cwd: BUSINESS, stdio: "pipe" });
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
