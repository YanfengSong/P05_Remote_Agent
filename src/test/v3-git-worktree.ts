import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GitWorktreeError, GitWorktreeIsolationManager } from "../v3/git-worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
async function commit(root: string, file: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(root, file), content, "utf8");
  git(root, ["add", "--", file]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
const hasCode = (code: string) => (error: unknown) => error instanceof GitWorktreeError && error.code === code;

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "p05-v3-t40-"));
const repo = path.join(fixture, "repo");
const isolationRoot = path.join(fixture, "isolations");
await fs.mkdir(repo, { recursive: true });

try {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "P05 T40"]);
  git(repo, ["config", "user.email", "p05-t40@example.invalid"]);
  await fs.writeFile(path.join(repo, "shared.txt"), "base\n", "utf8");
  await fs.writeFile(path.join(repo, "scope.txt"), "scope-base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  const manager = new GitWorktreeIsolationManager(repo, isolationRoot);
  const a = await manager.create({ isolationId: "agent-a", ownerRun: "run-a", branch: "agent/a", writeIntent: ["shared.txt"] });
  const b = await manager.create({ isolationId: "agent-b", ownerRun: "run-b", branch: "agent/b", writeIntent: ["shared.txt"] });

  assert.equal(a.baseCommit, base);
  assert.equal(b.baseCommit, base);
  assert.notEqual(a.root, b.root);
  assert.equal((await fs.readFile(path.join(repo, "shared.txt"), "utf8")).trimEnd(), "base");
  assert.equal((await fs.readFile(path.join(a.root, "shared.txt"), "utf8")).trimEnd(), "base");
  assert.equal((await fs.readFile(path.join(b.root, "shared.txt"), "utf8")).trimEnd(), "base");

  const aHead = await commit(a.root, "shared.txt", "agent-a\n", "agent a change");
  const bHead = await commit(b.root, "shared.txt", "agent-b\n", "agent b change");
  assert.notEqual(aHead, bHead);
  assert.equal((await fs.readFile(path.join(repo, "shared.txt"), "utf8")).trimEnd(), "base", "isolated writes must not mutate target worktree");

  const mainBefore = git(repo, ["rev-parse", "HEAD"]);
  await assert.rejects(manager.integrate({
    isolationId: "agent-a", targetBranch: "main", authorized: false, validationPassed: true, integrationGuard: () => true
  }), hasCode("INTEGRATION_AUTHORIZATION_REQUIRED"));
  await assert.rejects(manager.integrate({
    isolationId: "agent-a", targetBranch: "main", authorized: true, validationPassed: false, integrationGuard: () => true
  }), hasCode("INTEGRATION_VALIDATION_REQUIRED"));
  await assert.rejects(manager.integrate({
    isolationId: "agent-a", targetBranch: "main", authorized: true, validationPassed: true, integrationGuard: () => false
  }), hasCode("INTEGRATION_LEASE_REQUIRED"));
  assert.equal(git(repo, ["rev-parse", "HEAD"]), mainBefore);
  assert.equal((await fs.readFile(path.join(repo, "shared.txt"), "utf8")).trimEnd(), "base");

  let guardChecks = 0;
  const integratedA = await manager.integrate({
    isolationId: "agent-a",
    targetBranch: "main",
    authorized: true,
    validationPassed: true,
    integrationGuard: ({ isolation, targetHead, candidateHead }) => {
      guardChecks++;
      assert.equal(isolation.ownerRun, "run-a");
      assert.equal(targetHead, mainBefore);
      assert.equal(candidateHead, aHead);
      return true;
    }
  });
  assert.equal(integratedA.state, "INTEGRATED");
  assert.ok(guardChecks >= 2, "integration lease must be revalidated before final merge");
  const headAfterA = git(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(headAfterA, mainBefore);
  assert.equal((await fs.readFile(path.join(repo, "shared.txt"), "utf8")).trimEnd(), "agent-a");

  const conflictB = await manager.integrate({
    isolationId: "agent-b",
    targetBranch: "main",
    authorized: true,
    validationPassed: true,
    integrationGuard: () => true
  });
  assert.equal(conflictB.state, "CONFLICT");
  assert.deepEqual(conflictB.conflicts, ["shared.txt"]);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), headAfterA, "conflicting candidate must not move target HEAD");
  assert.equal((await fs.readFile(path.join(repo, "shared.txt"), "utf8")).trimEnd(), "agent-a", "conflicting candidate must not overwrite target content");
  assert.equal((await fs.readFile(path.join(b.root, "shared.txt"), "utf8")).trimEnd(), "agent-b", "conflicting worktree must be retained");
  assert.equal(git(b.root, ["rev-parse", "HEAD"]), bHead, "conflicting candidate commit must remain intact");
  assert.equal(manager.get("agent-b").lifecycle, "CONFLICT");

  const c = await manager.create({ isolationId: "agent-c", ownerRun: "run-c", branch: "agent/c", writeIntent: ["shared.txt"] });
  await commit(c.root, "scope.txt", "out-of-scope\n", "out of declared scope");
  await assert.rejects(manager.integrate({
    isolationId: "agent-c", targetBranch: "main", authorized: true, validationPassed: true, integrationGuard: () => true
  }), hasCode("WRITE_INTENT_VIOLATION"));
  assert.equal(git(repo, ["rev-parse", "HEAD"]), headAfterA);
  assert.equal(await fs.readFile(path.join(repo, "scope.txt"), "utf8"), "scope-base\n");

  console.log("V3_T40_GIT_WORKTREE_OK (real concurrent worktrees, authorization+validation+lease gate, declared write scope, conflict preview, target unchanged, conflicting work retained)");
} finally {
  try { git(repo, ["worktree", "remove", "--force", path.join(isolationRoot, "agent-a")]); } catch {}
  try { git(repo, ["worktree", "remove", "--force", path.join(isolationRoot, "agent-b")]); } catch {}
  try { git(repo, ["worktree", "remove", "--force", path.join(isolationRoot, "agent-c")]); } catch {}
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}
