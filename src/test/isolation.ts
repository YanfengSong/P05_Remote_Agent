import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceIsolationManager } from "../isolation/manager.js";
import { createExecutionContext } from "../runtime/context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_isolation_test");
const WS = path.join(FIXTURE, "workspace");
const ISO = path.join(FIXTURE, "isolations");
const STATE = path.join(FIXTURE, "state.json");

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

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(WS, { recursive: true });
await fs.mkdir(ISO, { recursive: true });

execFileSync("git", ["init", "-b", "main"], { cwd: WS, stdio: "pipe" });
execFileSync("git", ["config", "user.name", "P05 Isolation Test"], { cwd: WS });
execFileSync("git", ["config", "user.email", "p05-isolation@example.invalid"], { cwd: WS });
await fs.writeFile(path.join(WS, "base.txt"), "base\n", "utf8");
execFileSync("git", ["add", "base.txt"], { cwd: WS });
execFileSync("git", ["commit", "-m", "base"], { cwd: WS, stdio: "pipe" });

const contextA = createExecutionContext({
  workspace: { id: "ws", root: WS },
  actor: { type: "agent", id: "agent-a" },
  profile: "developer"
});
const contextB = createExecutionContext({
  workspace: { id: "ws", root: WS },
  actor: { type: "agent", id: "agent-b" },
  profile: "developer"
});

const manager = new WorkspaceIsolationManager({
  statePath: STATE,
  isolationRoot: ISO,
  allowedRoots: [FIXTURE],
  workspaceRoots: () => [WS]
});

try {
  check("isolation: configured root is active", manager.configured());

  const shared = await manager.allocate(contextA, "workspace");
  check("isolation: workspace mode uses source root", shared.isolation.root === WS);
  check("isolation: workspace mode captured in context", shared.context.isolation?.kind === "workspace");
  await manager.release(shared.context, shared.isolation.id);

  const first = await manager.allocate(contextA, "worktree");
  const second = await manager.allocate(contextA, "worktree");
  check("isolation: worktree mode returns isolated context", first.context.isolation?.kind === "worktree");
  check("isolation: worktree root differs from source workspace", first.isolation.root !== WS);
  check("isolation: parallel allocations use different roots", first.isolation.root !== second.isolation.root);
  check("isolation: initial worktree is clean", first.isolation.dirty === false);
  check("isolation: base commit recorded", typeof first.isolation.baseCommit === "string");

  await rejects(
    "isolation: actor ownership is enforced",
    () => manager.inspect(contextB, first.isolation.id),
    "different execution actor"
  );

  await fs.writeFile(path.join(first.isolation.root, "agent.txt"), "agent change\n", "utf8");
  const dirty = await manager.inspect(first.context, first.isolation.id);
  check("isolation: dirty state detected", dirty.dirty === true);
  await rejects(
    "isolation: dirty worktree cannot be released",
    () => manager.release(first.context, first.isolation.id),
    "uncommitted changes"
  );

  execFileSync("git", ["add", "agent.txt"], { cwd: first.isolation.root });
  execFileSync("git", ["commit", "-m", "agent result"], { cwd: first.isolation.root, stdio: "pipe" });
  const plan = await manager.prepareReconcile(first.context, first.isolation.id);
  check("isolation: reconcile sees committed result", plan.commits.length === 1, JSON.stringify(plan));
  check("isolation: clean committed result is ready", plan.ready && !plan.dirty);
  check("isolation: result commit differs from base", plan.currentCommit !== plan.baseCommit);

  await rejects(
    "isolation: unreconciled commit prevents release",
    () => manager.release(first.context, first.isolation.id),
    "unreconciled commits"
  );

  await manager.acknowledgeReconciled(
    first.context,
    first.isolation.id,
    plan.currentCommit
  );
  const released = await manager.release(first.context, first.isolation.id);
  check("isolation: acknowledged result can be released", released.state === "released");
  check("isolation: released worktree directory removed",
    await fs.access(first.isolation.root).then(() => false).catch(() => true)
  );

  const secondReleased = await manager.release(second.context, second.isolation.id);
  check("isolation: unchanged worktree can be released", secondReleased.state === "released");

  const stateText = await fs.readFile(STATE, "utf8");
  check("isolation: state persists logical records", stateText.includes(first.isolation.id));
  check("isolation: state does not persist absolute worktree root", !stateText.includes(first.isolation.root));

  const noRoot = new WorkspaceIsolationManager({
    statePath: path.join(FIXTURE, "no-root.json"),
    allowedRoots: [FIXTURE],
    workspaceRoots: () => [WS]
  });
  check("isolation: unconfigured manager reports disabled", !noRoot.configured());
  const noRootShared = await noRoot.allocate(contextA, "workspace");
  check("isolation: workspace mode works without isolation root", noRootShared.isolation.root === WS);
  await rejects(
    "isolation: worktree mode fails closed without configured root",
    () => noRoot.allocate(contextA, "worktree"),
    "not configured"
  );

  await rejects(
    "isolation: root overlapping workspace is refused",
    () => Promise.resolve(new WorkspaceIsolationManager({
      statePath: path.join(FIXTURE, "bad.json"),
      isolationRoot: WS,
      allowedRoots: [FIXTURE],
      workspaceRoots: () => [WS]
    })),
    "must not overlap"
  );

  console.log(`ISOLATION_OK (${checks} checks)`);
} finally {
  execFileSync("git", ["worktree", "prune"], { cwd: WS, stdio: "pipe" });
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
