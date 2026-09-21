import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "../audit/store.js";
import { capabilityDescriptor, capabilityRegistry } from "../capability/registry.js";
import { ExecutionRuntime } from "../runtime/execution.js";
import { AuthorizationError } from "../runtime/errors.js";
import { resolveDownstreamTarget } from "../downstream/types.js";
import { readTextFile, writeTextFile } from "../tools/files.js";
import { gitStatus } from "../tools/git.js";
import { runPowerShell } from "../tools/shell.js";
import { defaultP05StateDir, p05StateDir } from "../state.js";
import { WorkspaceManager, parseWorkspaceRegistry } from "../workspace/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_foundation_test");
const WS_A = path.join(FIXTURE, "workspace-a");
const WS_B = path.join(FIXTURE, "workspace-b");
const REGISTRY_ALLOWED = path.join(FIXTURE, "registry-allowed");
const REGISTRY_OUTSIDE = path.join(FIXTURE, "registry-outside");
const REGISTRY_JUNCTION = path.join(REGISTRY_ALLOWED, "escape-link");
const EXPLICIT_STATE = path.join(FIXTURE, "explicit-state");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}
function throws(label: string, fn: () => unknown, mustContain?: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, mustContain ? message.includes(mustContain) : true, message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected throw`);
}

async function rejects(label: string, fn: () => Promise<unknown>, mustContain?: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, mustContain ? message.includes(mustContain) : true, message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected rejection`);
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(WS_A, { recursive: true });
await fs.mkdir(WS_B, { recursive: true });
await fs.mkdir(REGISTRY_ALLOWED, { recursive: true });
await fs.mkdir(REGISTRY_OUTSIDE, { recursive: true });

try {
  check("state: default directory is anchored to the P05 repository", defaultP05StateDir() === path.join(REPO, ".p05"), defaultP05StateDir());
  check("state: explicit P05_STATE_DIR override is honored", p05StateDir(EXPLICIT_STATE) === path.resolve(EXPLICIT_STATE), p05StateDir(EXPLICIT_STATE));

  const raw = JSON.stringify([
    { id: "a", root: WS_A, kind: "platform-source", label: "Platform Workspace" },
    { id: "b", root: WS_B, kind: "git-project", label: "Workspace B" }
  ]);
  const parsed = parseWorkspaceRegistry(raw, [REPO], WS_A);
  check("workspace: two entries parsed", parsed.length === 2);

  const manager = new WorkspaceManager(parsed, "a");
  check("workspace: initial id selected", manager.current().id === "a");
  check("workspace: list does not expose root", !JSON.stringify(manager.list()).includes(REPO));

  await writeTextFile("marker.txt", "A", manager.currentRoot());
  check("workspace: relative file write/read uses active root",
    (await readTextFile("marker.txt", manager.currentRoot())) === "A");

  execFileSync("git", ["init", "-b", "workspace-a"], { cwd: WS_A, stdio: "pipe" });
  execFileSync("git", ["init", "-b", "workspace-b"], { cwd: WS_B, stdio: "pipe" });
  check("workspace: git uses workspace A", (await gitStatus(manager.currentRoot())).includes("workspace-a"));

  const shellA = await runPowerShell(
    "Write-Output (Split-Path -Leaf (Get-Location))",
    manager.currentRoot()
  );
  check("workspace: shell default cwd uses workspace A", shellA.stdout.includes("workspace-a"), shellA.stdout);

  manager.switch("b");
  check("workspace: platform root remains stable after switch", manager.platformRoot() === path.resolve(WS_A));
  await writeTextFile("marker.txt", "B", manager.currentRoot());
  check("workspace: switch changes relative file root",
    (await readTextFile("marker.txt", manager.currentRoot())) === "B");

  await rejects(
    "workspace: cross-workspace absolute write refused",
    () => writeTextFile(path.join(WS_A, "cross-write.txt"), "x", manager.currentRoot()),
    "outside the active workspace"
  );
  await rejects(
    "workspace: cross-workspace absolute read refused",
    () => readTextFile(path.join(WS_A, "marker.txt"), manager.currentRoot()),
    "outside the active workspace"
  );
  check("workspace: git follows switch", (await gitStatus(manager.currentRoot())).includes("workspace-b"));

  const shellB = await runPowerShell(
    "Write-Output (Split-Path -Leaf (Get-Location))",
    manager.currentRoot()
  );
  check("workspace: shell follows switch", shellB.stdout.includes("workspace-b"), shellB.stdout);

  throws("workspace: unknown id refused", () => manager.switch("missing"), "not registered");
  throws("workspace: exactly one platform-source required", () =>
    parseWorkspaceRegistry(
      JSON.stringify([
        { id: "x", root: WS_A, kind: "git-project" },
        { id: "y", root: WS_B, kind: "generic" }
      ]),
      [REPO],
      WS_A
    ), "exactly one platform-source");
  throws("workspace: outside allowed roots refused", () =>
    parseWorkspaceRegistry(
      JSON.stringify([{ id: "outside", root: path.parse(REPO).root, kind: "generic" }]),
      [REPO],
      WS_A
    ), "outside REMOTE_AGENT_ALLOWED_ROOTS");

  execFileSync("cmd", ["/c", "mklink", "/J", REGISTRY_JUNCTION, REGISTRY_OUTSIDE], { stdio: "pipe" });
  throws("workspace: junction root escape refused", () =>
    parseWorkspaceRegistry(
      JSON.stringify([{ id: "escape", root: REGISTRY_JUNCTION, kind: "generic" }]),
      [REGISTRY_ALLOWED],
      REGISTRY_ALLOWED
    ), "resolves outside REMOTE_AGENT_ALLOWED_ROOTS");

  const activeTarget = resolveDownstreamTarget(
    { id: "matlab", label: "MATLAB", enabled: true, workspaceBinding: "active" },
    {
      active: { id: manager.current().id, root: manager.currentRoot() },
      platform: { id: manager.platform().id, root: manager.platformRoot() }
    }
  );
  check("downstream: active binding follows current workspace",
    activeTarget.workspaceId === "b" && activeTarget.cwd === manager.currentRoot());

  const platformTarget = resolveDownstreamTarget(
    { id: "matlab", label: "MATLAB", enabled: true, workspaceBinding: "platform" },
    {
      active: { id: manager.current().id, root: manager.currentRoot() },
      platform: { id: manager.platform().id, root: manager.platformRoot() }
    }
  );
  check("downstream: platform binding ignores active business workspace",
    platformTarget.workspaceId === "a" && platformTarget.cwd === manager.platformRoot());

  const registry = capabilityRegistry();
  check("capability: registry is non-empty", registry.length > 0);
  check("capability: names are unique", new Set(registry.map((entry) => entry.name)).size === registry.length);
  check("capability: shell is workspace scoped", capabilityDescriptor("shell_run").scope === "workspace");
  check("capability: restart is host scoped", capabilityDescriptor("runtime_restart").scope === "host");
  check("capability: workspace switch is platform scoped", capabilityDescriptor("workspace_switch").scope === "platform");

  const audit = new AuditStore(20);
  const runtime = new ExecutionRuntime(audit, () => manager.current().id);
  await runtime.run("workspace_current", async () => "ok");
  try {
    await runtime.run("workspace_switch", async () => {
      throw new Error("synthetic failure");
    });
  } catch {
    // expected
  }
  try {
    await runtime.run("workspace_switch", {
      authorize: () => { throw new AuthorizationError("synthetic policy denial"); },
      execute: async () => "unreachable"
    });
  } catch {
    // expected
  }
  try {
    await runtime.run("workspace_current", async () => {
      const error = Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
      throw error;
    });
  } catch {
    // expected
  }

  const recent = audit.recent(20);
  check("runtime: success record exists",
    recent.some((event) => event.capability === "workspace_current" && event.state === "succeeded"));
  check("runtime: failure record exists",
    recent.some((event) => event.capability === "workspace_switch" && event.state === "failed"));
  check("runtime: policy errors classified",
    recent.some((event) =>
      event.capability === "workspace_switch" &&
      event.errorCategory === "policy" &&
      event.phase === "authorize" &&
      event.recoveryHint === "human"));
  check("runtime: timeout errors classified",
    recent.some((event) =>
      event.capability === "workspace_current" &&
      event.errorCategory === "timeout" &&
      event.phase === "execute" &&
      event.recoveryHint === "retry"));
  check("runtime: generic tool errors classified",
    recent.some((event) =>
      event.capability === "workspace_switch" &&
      event.errorCategory === "tool" &&
      event.phase === "execute"));
  check("audit: records carry workspace id", recent.every((event) => event.workspaceId === "b"));
  check("audit: one final record per execution id",
    new Set(recent.map((event) => event.id)).size === recent.length,
    JSON.stringify(recent));
  check("audit: records contain no command or file-content fields",
    recent.every((event) => !("command" in event) && !("content" in event) && !("args" in event)));

  const persistentAuditPath = path.join(FIXTURE, "audit.json");
  const beforeRestart = new AuditStore(20, persistentAuditPath);
  beforeRestart.upsert({
    id: "interrupted-test",
    capability: "git_commit",
    scope: "workspace",
    workspaceId: manager.current().id,
    state: "running",
    phase: "execute",
    startedAt: new Date().toISOString(),
    recoveryHint: "inspect"
  });
  const afterRestart = new AuditStore(20, persistentAuditPath);
  const interrupted = afterRestart.recovery(20).find((event) => event.id === "interrupted-test");
  check("recovery: persistent audit marks running execution interrupted",
    interrupted?.state === "failed" &&
    interrupted.errorCategory === "interrupted" &&
    interrupted.phase === "execute" &&
    interrupted.recoveryHint === "inspect",
    JSON.stringify(interrupted));
  check("recovery: persisted record keeps workspace id",
    interrupted?.workspaceId === manager.current().id, JSON.stringify(interrupted));

  console.log(`FOUNDATION_OK (${checks} checks)`);
} finally {
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}