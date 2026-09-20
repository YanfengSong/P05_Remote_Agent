import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertAccessiblePath } from "../security.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_COMMIT_MESSAGE = 4096;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function bounded(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return text;
  return Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n[TRUNCATED: git output exceeded 256 KiB]";
}

async function runGit(args: string[], workspaceRoot: string, timeout = 60_000): Promise<string> {
  const cwd = await assertAccessiblePath(workspaceRoot, "read", workspaceRoot, workspaceRoot);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
    return bounded(out);
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(
      bounded(["Git command failed.", stdout, stderr].filter(Boolean).join("\n"))
    );
  }
}

function validateBranchName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255 || trimmed.startsWith("-")) {
    throw new Error("Invalid Git branch name.");
  }
  return trimmed;
}

async function assertBranchName(name: string, workspaceRoot: string): Promise<string> {
  const branch = validateBranchName(name);
  await runGit(["check-ref-format", "--branch", branch], workspaceRoot);
  return branch;
}

function safePathspecInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Git add path must not be blank.");
  if (trimmed.startsWith(":(") || trimmed.startsWith(":/") || trimmed.startsWith(":!")) {
    throw new Error("Git pathspec magic is not supported.");
  }
  return trimmed;
}

async function normalizedGitPath(input: string, workspaceRoot: string): Promise<string> {
  const requested = safePathspecInput(input);
  if (requested === ".") return ".";
  const safe = await assertAccessiblePath(requested, "read", workspaceRoot, workspaceRoot);
  const relative = path.relative(workspaceRoot, safe);
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Git path is outside the active workspace.");
  }
  return relative.replaceAll("\\", "/");
}

export async function gitStatus(workspaceRoot: string): Promise<string> {
  return runGit(["status", "--short", "--branch", "--untracked-files=all"], workspaceRoot);
}

export async function gitDiff(workspaceRoot: string, staged = false): Promise<string> {
  return runGit(["diff", "--no-ext-diff", ...(staged ? ["--cached"] : [])], workspaceRoot);
}

export async function gitDiffStat(workspaceRoot: string, staged = false): Promise<string> {
  return runGit(["diff", "--stat", "--no-ext-diff", ...(staged ? ["--cached"] : [])], workspaceRoot);
}

export async function gitAdd(workspaceRoot: string, paths: readonly string[]): Promise<string> {
  if (paths.length === 0 || paths.length > 200) {
    throw new Error("git_add requires 1..200 paths.");
  }
  const normalized: string[] = [];
  for (const input of paths) normalized.push(await normalizedGitPath(input, workspaceRoot));
  await runGit(["add", "--", ...normalized], workspaceRoot);
  return gitStatus(workspaceRoot);
}

export async function gitCommit(workspaceRoot: string, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Commit message must not be blank.");
  if (trimmed.length > MAX_COMMIT_MESSAGE) {
    throw new Error(`Commit message exceeds ${MAX_COMMIT_MESSAGE} characters.`);
  }
  return runGit(["commit", "-m", trimmed], workspaceRoot, 120_000);
}

export type GitBranchAction = "create" | "switch" | "delete";

export async function gitBranch(
  workspaceRoot: string,
  action: GitBranchAction,
  name: string
): Promise<string> {
  const branch = await assertBranchName(name, workspaceRoot);
  switch (action) {
    case "create":
      return runGit(["switch", "-c", branch], workspaceRoot);
    case "switch":
      return runGit(["switch", branch], workspaceRoot);
    case "delete":
      return runGit(["branch", "-d", branch], workspaceRoot);
  }
}

export async function gitPush(
  workspaceRoot: string,
  remote = "origin",
  setUpstream = false
): Promise<string> {
  const normalizedRemote = remote.trim();
  if (!SAFE_REMOTE.test(normalizedRemote)) {
    throw new Error("Invalid Git remote name.");
  }
  const branch = (await runGit(["branch", "--show-current"], workspaceRoot)).trim();
  if (!branch) throw new Error("Cannot push from detached HEAD.");
  const args = ["push", ...(setUpstream ? ["--set-upstream"] : []), normalizedRemote, "HEAD"];
  return runGit(args, workspaceRoot, 180_000);
}