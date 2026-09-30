import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ReferenceManager } from "../reference/manager.js";
import { readTextFile, writeTextFile } from "../tools/files.js";
import { ArtifactStore, ArtifactStoreError } from "../v3/artifacts.js";
import { GitWorktreeError, GitWorktreeIsolationManager } from "../v3/git-worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
const gitCode = (code: string) => (error: unknown) => error instanceof GitWorktreeError && error.code === code;
const artifactCode = (code: string) => (error: unknown) => error instanceof ArtifactStoreError && error.code === code;

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "p05-v3-t41-"));
const repo = path.join(fixture, "repo");
const isolationRoot = path.join(fixture, "isolations");
const referencesFile = path.join(fixture, "state", "references.json");
const artifactRoot = path.join(fixture, "artifacts");
await fs.mkdir(repo, { recursive: true });

let store: ArtifactStore | undefined;
try {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "P05 T41"]);
  git(repo, ["config", "user.email", "p05-t41@example.invalid"]);
  await fs.writeFile(path.join(repo, "shared.txt"), "reference-safe\n", "utf8");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "base"]);

  const manager = new GitWorktreeIsolationManager(repo, isolationRoot);
  const isolation = await manager.create({ isolationId: "agent-a", ownerRun: "run-a", branch: "agent/a", writeIntent: ["shared.txt"] });
  const dotGit = await fs.readFile(path.join(isolation.root, ".git"), "utf8");
  assert.match(dotGit, /^gitdir:/i, "linked worktree uses shared Git administrative metadata");

  await assert.rejects(
    manager.create({ isolationId: "bad-git", ownerRun: "run-b", branch: "agent/bad-git", writeIntent: [".git/config"] }),
    gitCode("SHARED_GIT_METADATA_FORBIDDEN")
  );
  await assert.rejects(
    writeTextFile(".git/config", "[core]\nrepositoryformatversion=999\n", isolation.root),
    /protected/
  );

  const references = new ReferenceManager(referencesFile);
  const reference = references.add(repo);
  assert.equal(references.list()[0]?.id, reference.id);
  assert.equal("root" in (references.list()[0] as object), false, "remote Reference view must not disclose host root");
  assert.equal((await readTextFile("shared.txt", reference.root)).trim(), "reference-safe");
  await assert.rejects(readTextFile(".git/config", reference.root), /protected/);

  const outside = path.join(fixture, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  const link = path.join(repo, "linked-outside");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readTextFile("linked-outside/secret.txt", reference.root), /outside the active workspace/);
  await fs.rm(link, { force: true });

  let now = 1_000;
  store = new ArtifactStore({ root: artifactRoot, now: () => now, defaultRetentionMs: 0 });
  const artifactStore = store;

  const sharedActive = artifactStore.publish({ producerRun: "run-active", mediaType: "text/plain", content: "same-content" });
  const sharedExpired = artifactStore.publish({ producerRun: "run-expired", mediaType: "text/plain", content: "same-content" });
  const pending = artifactStore.publish({ producerRun: "run-review", mediaType: "text/plain", content: "review", protections: ["active-run", "pending-review"] });
  const pinned = artifactStore.publish({ producerRun: "run-pin", mediaType: "text/plain", content: "pin", protections: ["active-run", "pin"] });
  const rollback = artifactStore.publish({ producerRun: "run-rollback", mediaType: "text/plain", content: "rollback", protections: ["active-run", "rollback"] });

  artifactStore.completeRun("run-expired");
  artifactStore.completeRun("run-review");
  artifactStore.completeRun("run-pin");
  artifactStore.completeRun("run-rollback");
  now++;

  const firstGc = artifactStore.gc({ maxScan: 20, maxDelete: 10 });
  assert.equal(firstGc.deletedArtifacts, 1, "only the completed unprotected Artifact is eligible");
  assert.equal(firstGc.deletedBlobs, 0, "shared content blob must survive while an active Artifact still references it");
  assert.equal(artifactStore.read(sharedActive.artifactId).toString("utf8"), "same-content");
  assert.throws(() => artifactStore.get(sharedExpired.artifactId), artifactCode("ARTIFACT_NOT_FOUND"));
  assert.equal(artifactStore.read(pending.artifactId).toString(), "review");
  assert.equal(artifactStore.read(pinned.artifactId).toString(), "pin");
  assert.equal(artifactStore.read(rollback.artifactId).toString(), "rollback");

  artifactStore.updateProtection(pending.artifactId, "pending-review", false);
  artifactStore.updateProtection(pinned.artifactId, "pin", false);
  artifactStore.updateProtection(rollback.artifactId, "rollback", false);
  const protectedGc = artifactStore.gc({ maxScan: 20, maxDelete: 10 });
  assert.equal(protectedGc.deletedArtifacts, 3, "completed artifacts become collectable only after explicit protections clear");
  assert.equal(artifactStore.read(sharedActive.artifactId).toString(), "same-content");

  artifactStore.completeRun("run-active");
  const activeReleased = artifactStore.gc({ maxScan: 20, maxDelete: 10 });
  assert.equal(activeReleased.deletedArtifacts, 1);
  assert.equal(activeReleased.deletedBlobs, 1, "shared blob is removed only after its final Artifact reference is gone");
  assert.throws(() => artifactStore.read(sharedActive.artifactId), artifactCode("ARTIFACT_NOT_FOUND"));

  const boundedIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const item = artifactStore.publish({ producerRun: "run-bounded-" + i, mediaType: "text/plain", content: "bounded-" + i });
    artifactStore.completeRun("run-bounded-" + i);
    boundedIds.push(item.artifactId);
  }
  const bounded = artifactStore.gc({ maxScan: 20, maxDelete: 1 });
  assert.equal(bounded.deletedArtifacts, 1, "GC deletion work is bounded by maxDelete");
  const survivors = boundedIds.filter(id => {
    try { artifactStore.get(id); return true; } catch { return false; }
  });
  assert.equal(survivors.length, 2);

  const orphanContent = Buffer.from("crash-before-index", "utf8");
  const orphanDigest = createHash("sha256").update(orphanContent).digest("hex");
  const orphanPath = path.join(artifactRoot, "blobs", orphanDigest.slice(0, 2), orphanDigest.slice(2));
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.writeFile(orphanPath, orphanContent);
  while (survivors.length) {
    const id = survivors.pop()!;
    const record = artifactStore.get(id);
    artifactStore.updateProtection(id, "active-run", false);
    if (record.completedAt === null) artifactStore.completeRun(record.producerRun);
  }
  artifactStore.gc({ maxScan: 20, maxDelete: 10 });
  assert.equal(await fs.stat(orphanPath).then(() => true).catch(() => false), false, "orphan blob from interrupted publish is reclaimed");

  console.log("V3_T41_REFERENCE_ARTIFACT_GC_OK (Reference path containment/read-only surface, shared .git metadata protected, active/review/pin/rollback artifacts retained, shared blobs safe, bounded orphan GC)");
} finally {
  store?.close();
  try { git(repo, ["worktree", "remove", "--force", path.join(isolationRoot, "agent-a")]); } catch {}
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}