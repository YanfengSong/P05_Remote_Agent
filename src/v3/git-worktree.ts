import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const branchPattern = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,190}$/;

export type WorktreeIsolation = {
  isolationId: string;
  baseCommit: string;
  branch: string;
  root: string;
  ownerRun: string;
  writeIntent: string[];
  lifecycle: "ACTIVE" | "COMPLETED" | "CONFLICT";
  retention: "retain";
};

export type IntegrationGuard = (input: {
  repoRoot: string;
  targetBranch: string;
  isolation: Readonly<WorktreeIsolation>;
  targetHead: string;
  candidateHead: string;
}) => Promise<boolean> | boolean;

export class GitWorktreeError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "GitWorktreeError"; }
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { stdout: String(stdout).trim(), stderr: String(stderr).trim(), code: 0 };
  } catch (error: any) {
    const code = Number.isInteger(error?.code) ? Number(error.code) : 1;
    const result = { stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "", stderr: typeof error?.stderr === "string" ? error.stderr.trim() : "", code };
    if (allowFailure) return result;
    throw new GitWorktreeError("GIT_COMMAND_FAILED", [result.stdout, result.stderr].filter(Boolean).join("\n") || "Git command failed");
  }
}

function normalize(p: string): string { return process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p); }
function below(child: string, parent: string): boolean {
  const c = normalize(child), p = normalize(parent);
  return c !== p && c.startsWith(p + path.sep);
}
function validateWriteIntent(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 256) throw new GitWorktreeError("INVALID_WRITE_INTENT");
  const result = paths.map(value => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    const segments = normalized.split("/").map(segment => segment.replace(/[. ]+$/, "").toLowerCase());
    if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes("\0") || normalized.startsWith(":")) throw new GitWorktreeError("INVALID_WRITE_INTENT");
    if (segments.includes(".git")) throw new GitWorktreeError("SHARED_GIT_METADATA_FORBIDDEN");
    return normalized;
  });
  return [...new Set(result)];
}

export class GitWorktreeIsolationManager {
  private readonly records = new Map<string, WorktreeIsolation>();
  constructor(readonly repoRoot: string, readonly isolationRoot: string) {
    if (!path.isAbsolute(repoRoot) || !path.isAbsolute(isolationRoot)) throw new GitWorktreeError("ABSOLUTE_PATH_REQUIRED");
    if (below(isolationRoot, repoRoot) || normalize(isolationRoot) === normalize(repoRoot)) throw new GitWorktreeError("ISOLATION_ROOT_OVERLAPS_REPO");
  }

  async create(input: { isolationId: string; ownerRun: string; branch: string; writeIntent: string[] }): Promise<WorktreeIsolation> {
    if (!id.test(input.isolationId) || !id.test(input.ownerRun) || !branchPattern.test(input.branch) || input.branch.startsWith("-")) throw new GitWorktreeError("INVALID_ISOLATION_IDENTITY");
    if (this.records.has(input.isolationId)) throw new GitWorktreeError("ISOLATION_EXISTS");
    const writeIntent = validateWriteIntent(input.writeIntent);
    const repo = (await git(this.repoRoot, ["rev-parse", "--show-toplevel"])).stdout;
    if (normalize(repo) !== normalize(this.repoRoot)) throw new GitWorktreeError("REPO_ROOT_MISMATCH");
    const baseCommit = (await git(this.repoRoot, ["rev-parse", "HEAD"])).stdout;
    const root = path.join(this.isolationRoot, input.isolationId);
    if (fs.existsSync(root)) throw new GitWorktreeError("ISOLATION_ROOT_EXISTS");
    fs.mkdirSync(this.isolationRoot, { recursive: true });
    await git(this.repoRoot, ["check-ref-format", "--branch", input.branch]);
    await git(this.repoRoot, ["worktree", "add", "-b", input.branch, root, baseCommit]);
    const record: WorktreeIsolation = {
      isolationId: input.isolationId,
      baseCommit,
      branch: input.branch,
      root,
      ownerRun: input.ownerRun,
      writeIntent,
      lifecycle: "ACTIVE",
      retention: "retain"
    };
    this.records.set(input.isolationId, record);
    return structuredClone(record);
  }

  get(isolationId: string): WorktreeIsolation {
    const value = this.records.get(isolationId);
    if (!value) throw new GitWorktreeError("ISOLATION_NOT_FOUND");
    return structuredClone(value);
  }

  async integrate(input: {
    isolationId: string;
    targetBranch: string;
    authorized: boolean;
    validationPassed: boolean;
    integrationGuard: IntegrationGuard;
  }): Promise<{ state: "INTEGRATED" | "CONFLICT"; targetHead: string; candidateHead: string; conflicts: string[] }> {
    const record = this.records.get(input.isolationId);
    if (!record || record.lifecycle !== "ACTIVE") throw new GitWorktreeError("ISOLATION_NOT_ACTIVE");
    if (!input.authorized) throw new GitWorktreeError("INTEGRATION_AUTHORIZATION_REQUIRED");
    if (!input.validationPassed) throw new GitWorktreeError("INTEGRATION_VALIDATION_REQUIRED");
    if (!branchPattern.test(input.targetBranch) || input.targetBranch.startsWith("-")) throw new GitWorktreeError("INVALID_TARGET_BRANCH");

    const candidateBranch = (await git(record.root, ["branch", "--show-current"])).stdout;
    if (candidateBranch !== record.branch) throw new GitWorktreeError("ISOLATION_BRANCH_CHANGED");
    const dirty = (await git(record.root, ["status", "--porcelain", "--untracked-files=all"])).stdout;
    if (dirty) throw new GitWorktreeError("ISOLATION_DIRTY");
    const candidateHead = (await git(record.root, ["rev-parse", "HEAD"])).stdout;
    const descendant = await git(record.root, ["merge-base", "--is-ancestor", record.baseCommit, candidateHead], true);
    if (descendant.code !== 0) throw new GitWorktreeError("CANDIDATE_NOT_DESCENDANT");
    const changedFiles = (await git(record.root, ["diff", "--name-only", record.baseCommit + ".." + candidateHead])).stdout.split(/\r?\n/).filter(Boolean);
    if (changedFiles.some(file => !record.writeIntent.includes(file.replaceAll("\\", "/")))) throw new GitWorktreeError("WRITE_INTENT_VIOLATION");

    const targetBranch = (await git(this.repoRoot, ["branch", "--show-current"])).stdout;
    if (targetBranch !== input.targetBranch) throw new GitWorktreeError("TARGET_BRANCH_NOT_CHECKED_OUT");
    const targetDirty = (await git(this.repoRoot, ["status", "--porcelain", "--untracked-files=all"])).stdout;
    if (targetDirty) throw new GitWorktreeError("TARGET_DIRTY");
    const targetHead = (await git(this.repoRoot, ["rev-parse", "HEAD"])).stdout;

    if (!await input.integrationGuard({ repoRoot: this.repoRoot, targetBranch: input.targetBranch, isolation: structuredClone(record), targetHead, candidateHead })) {
      throw new GitWorktreeError("INTEGRATION_LEASE_REQUIRED");
    }

    const previewRoot = path.join(this.isolationRoot, ".preview-" + record.isolationId + "-" + process.pid);
    if (fs.existsSync(previewRoot)) throw new GitWorktreeError("PREVIEW_ROOT_EXISTS");
    await git(this.repoRoot, ["worktree", "add", "--detach", previewRoot, targetHead]);
    let previewSucceeded = false;
    let conflicts: string[] = [];
    try {
      const preview = await git(previewRoot, ["merge", "--no-commit", "--no-ff", candidateHead], true);
      if (preview.code !== 0) {
        conflicts = (await git(previewRoot, ["diff", "--name-only", "--diff-filter=U"], true)).stdout.split(/\r?\n/).filter(Boolean);
        record.lifecycle = "CONFLICT";
        this.records.set(record.isolationId, record);
        return { state: "CONFLICT", targetHead, candidateHead, conflicts };
      }
      previewSucceeded = true;
    } finally {
      if (previewSucceeded) await git(previewRoot, ["merge", "--abort"], true);
      await git(this.repoRoot, ["worktree", "remove", "--force", previewRoot], true);
    }

    const unchangedTarget = (await git(this.repoRoot, ["rev-parse", "HEAD"])).stdout;
    if (unchangedTarget !== targetHead) throw new GitWorktreeError("TARGET_CHANGED_DURING_RECONCILE");
    if (!await input.integrationGuard({ repoRoot: this.repoRoot, targetBranch: input.targetBranch, isolation: structuredClone(record), targetHead, candidateHead })) {
      throw new GitWorktreeError("INTEGRATION_LEASE_REQUIRED");
    }
    const merged = await git(this.repoRoot, ["merge", "--no-ff", "--no-edit", candidateHead], true);
    if (merged.code !== 0) {
      await git(this.repoRoot, ["merge", "--abort"], true);
      throw new GitWorktreeError("TARGET_CHANGED_DURING_INTEGRATION");
    }
    record.lifecycle = "COMPLETED";
    this.records.set(record.isolationId, record);
    return { state: "INTEGRATED", targetHead: (await git(this.repoRoot, ["rev-parse", "HEAD"])).stdout, candidateHead, conflicts: [] };
  }
}
