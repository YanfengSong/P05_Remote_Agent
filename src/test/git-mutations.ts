import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitAdd, gitBranch, gitCommit, gitPush, gitStatus } from "../tools/git.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_git_mutation_test");
const WORK = path.join(FIXTURE, "work");
const OUTSIDE = path.join(FIXTURE, "outside");
const BARE = path.join(FIXTURE, "remote.git");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
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
await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(OUTSIDE, { recursive: true });

try {
  execFileSync("git", ["init", "-b", "main"], { cwd: WORK, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "P05 Test"], { cwd: WORK, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "p05-test@example.invalid"], { cwd: WORK, stdio: "pipe" });

  await fs.writeFile(path.join(WORK, "alpha.txt"), "alpha\n", "utf8");
  const staged = await gitAdd(WORK, ["alpha.txt"]);
  check("git_add: file staged", staged.includes("A  alpha.txt"), staged);

  const commit = await gitCommit(WORK, "test: initial");
  check("git_commit: commit created", /initial|root-commit/i.test(commit), commit);
  check("git_commit: worktree clean", !(await gitStatus(WORK)).includes("alpha.txt"));

  const created = await gitBranch(WORK, "create", "feature/test");
  check("git_branch: create switches branch", /feature\/test|Switched/i.test(created), created);
  check("git_branch: current branch is feature/test",
    execFileSync("git", ["branch", "--show-current"], { cwd: WORK }).toString().trim() === "feature/test");

  await gitBranch(WORK, "switch", "main");
  check("git_branch: switch returns to main",
    execFileSync("git", ["branch", "--show-current"], { cwd: WORK }).toString().trim() === "main");

  await gitBranch(WORK, "delete", "feature/test");
  check("git_branch: safe delete removed merged branch",
    !execFileSync("git", ["branch", "--list", "feature/test"], { cwd: WORK }).toString().includes("feature/test"));

  await fs.writeFile(path.join(OUTSIDE, "outside.txt"), "outside\n", "utf8");
  await rejects(
    "git_add: absolute path outside active workspace refused",
    () => gitAdd(WORK, [path.join(OUTSIDE, "outside.txt")]),
    "outside the active workspace"
  );
  await rejects(
    "git_add: pathspec magic refused",
    () => gitAdd(WORK, [":(glob)**/*.txt"]),
    "pathspec magic"
  );
  await rejects(
    "git_commit: blank message refused",
    () => gitCommit(WORK, "   "),
    "must not be blank"
  );
  await rejects(
    "git_branch: invalid option-like name refused",
    () => gitBranch(WORK, "create", "--evil"),
    "Invalid Git branch name"
  );

  execFileSync("git", ["init", "--bare", BARE], { cwd: FIXTURE, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", BARE], { cwd: WORK, stdio: "pipe" });
  const pushed = await gitPush(WORK, "origin", true);
  check("git_push: local bare remote accepted current HEAD",
    execFileSync("git", ["--git-dir", BARE, "show-ref", "--verify", "refs/heads/main"], { cwd: WORK, stdio: "pipe" })
      .toString().trim().length > 0,
    pushed
  );
  await rejects(
    "git_push: option-like remote refused",
    () => gitPush(WORK, "--force", false),
    "Invalid Git remote name"
  );

  console.log(`GIT_MUTATIONS_OK (${checks} checks)`);
} finally {
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
