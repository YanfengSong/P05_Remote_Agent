import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertAccessiblePath } from "../security.js";

const execFileAsync = promisify(execFile);
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_SAMPLES = 30;
const LARGE_FILE_BYTES = 10 * 1024 * 1024;

export type GitAuditEntry = {
  path: string;
  index: string;
  worktree: string;
  kind: "tracked" | "untracked";
};

export type GitAuditRisk = {
  path: string;
  reason: "generated_cache" | "raw_data_review" | "large_file";
  bytes?: number;
};

export type GitWorkspaceAudit = {
  readOnly: true;
  remoteRefsOnly: true;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  remotes: string[];
  recentCommits: string[];
  counts: {
    entries: number;
    staged: number;
    worktree: number;
    untracked: number;
    conflicts: number;
    deleted: number;
  };
  changedSample: GitAuditEntry[];
  untrackedGroups: Array<{ directory: string; count: number }>;
  risks: GitAuditRisk[];
  riskCount: number;
  truncated: boolean;
  warnings: string[];
};

async function runReadOnlyGit(cwd: string, args: string[], timeout = 30000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args],
      { cwd, timeout, windowsHide: true, maxBuffer: MAX_STATUS_BYTES }
    );
    return stdout;
  } catch {
    throw new Error("Git workspace audit query failed. No changes were made.");
  }
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try { return (await runReadOnlyGit(cwd, args)).trim() || null; }
  catch { return null; }
}

export function parsePorcelainStatus(raw: string, maxEntries = MAX_ENTRIES): {
  entries: GitAuditEntry[];
  truncated: boolean;
} {
  const fields = raw.split("\0");
  const entries: GitAuditEntry[] = [];
  let truncated = false;
  for (let i = 0; i < fields.length; i++) {
    const item = fields[i];
    if (!item) continue;
    if (item.length < 4 || item[2] !== " ") throw new Error("Malformed Git status response.");
    const index = item[0]!;
    const worktree = item[1]!;
    const filename = item.slice(3).replaceAll("\\", "/");
    if ((index === "R" || index === "C" || worktree === "R" || worktree === "C") && i + 1 < fields.length) {
      i++; // -z uses an additional original-path field for rename/copy.
    }
    if (entries.length >= maxEntries) { truncated = true; break; }
    entries.push({
      path: filename,
      index,
      worktree,
      kind: index === "?" && worktree === "?" ? "untracked" : "tracked"
    });
  }
  return { entries, truncated };
}

function riskReason(relative: string): GitAuditRisk["reason"] | null {
  const p = relative.replaceAll("\\", "/").toLowerCase();
  if (
    /(^|\/)(slprj|__pycache__|node_modules|test_tmp)(\/|$)/.test(p) ||
    /\.(slxc|asv|pyc|mexw64|obj)$/.test(p)
  ) return "generated_cache";
  if (/\.mat$/.test(p)) return "raw_data_review"; // .mat can also be intentional source data.
  return null;
}

function samePath(a: string, b: string): boolean {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Read-only, workspace-scoped Git snapshot.
 * Does not fetch, push, stage, commit, modify ignore rules or enumerate ignored files.
 * Counts are bounded to MAX_ENTRIES and marked truncated if the bound is reached.
 */
export async function gitWorkspaceAudit(workspaceRoot: string): Promise<GitWorkspaceAudit> {
  const cwd = await assertAccessiblePath(workspaceRoot, "read", workspaceRoot, workspaceRoot);
  const top = (await runReadOnlyGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!samePath(top, cwd)) {
    throw new Error("Git audit refused: repository root differs from the active workspace.");
  }

  const [statusRaw, branch, head, upstream, remotesRaw, recentRaw] = await Promise.all([
    runReadOnlyGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    optionalGit(cwd, ["rev-parse", "--verify", "--short=12", "HEAD"]),
    optionalGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    runReadOnlyGit(cwd, ["remote"]),
    optionalGit(cwd, ["log", "-5", "--format=%h %s"])
  ]);
  const { entries, truncated } = parsePorcelainStatus(statusRaw);
  const counts = { entries: entries.length, staged: 0, worktree: 0, untracked: 0, conflicts: 0, deleted: 0 };
  const groups = new Map<string, number>();
  const risks: GitAuditRisk[] = [];
  let riskCount = 0;

  for (const entry of entries) {
    if (entry.kind === "untracked") {
      counts.untracked++;
      const bits = entry.path.split("/");
      const directory = bits.length < 2 ? "." : bits.slice(0, Math.min(2, bits.length - 1)).join("/");
      groups.set(directory, (groups.get(directory) ?? 0) + 1);
    } else {
      if (entry.index !== " " && entry.index !== "?") counts.staged++;
      if (entry.worktree !== " " && entry.worktree !== "?") counts.worktree++;
      if (/U/.test(entry.index + entry.worktree) || entry.index + entry.worktree === "AA" ||
          entry.index + entry.worktree === "DD") counts.conflicts++;
      if (entry.index === "D" || entry.worktree === "D") counts.deleted++;
    }

    const reason = riskReason(entry.path);
    if (reason) {
      riskCount++;
      if (risks.length < MAX_SAMPLES) risks.push({ path: entry.path, reason });
    }
    if (entry.index === "D" || entry.worktree === "D") continue;
    // lstat does not follow links. Only consult changed paths inside the workspace.
    const absolute = path.resolve(cwd, entry.path);
    const rel = path.relative(cwd, absolute);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) continue;
    if (entry.path.split("/").includes("..")) continue;
    if (/\0/.test(entry.path)) continue;
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isFile() && stat.size >= LARGE_FILE_BYTES) {
        riskCount++;
        if (risks.length < MAX_SAMPLES) risks.push({
          path: entry.path, reason: "large_file", bytes: stat.size
        });
      }
    } catch { /* file may change while being audited */ }
  }

  let ahead: number | null = null, behind: number | null = null;
  if (upstream && head) {
    const divergence = await optionalGit(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const matched = divergence?.match(/^(\d+)\s+(\d+)$/);
    if (matched) { ahead = Number(matched[1]); behind = Number(matched[2]); }
  }

  const warnings: string[] = [];
  if (truncated) warnings.push("Status truncated at 5000 entries; counts and groups are partial.");
  if (!upstream) warnings.push("No upstream tracking branch; ahead/behind unavailable.");
  else warnings.push("Ahead/behind uses local tracking refs only; no network fetch was performed.");
  if (counts.conflicts > 0) warnings.push("Unmerged files detected; inspect before staging.");
  if (riskCount > 0) warnings.push("Generated/cache/data/large paths need individual review; not all .mat files are disposable.");
  warnings.push("Ignored files are not enumerated; this is a read-only working-tree snapshot.");

  return {
    readOnly: true, remoteRefsOnly: true,
    branch, head, upstream, ahead, behind,
    remotes: remotesRaw.trim().split(/\r?\n/).filter(Boolean).slice(0, 20),
    recentCommits: recentRaw?.split(/\r?\n/).filter(Boolean).slice(0, 5) ?? [],
    counts,
    changedSample: entries.slice(0, MAX_SAMPLES),
    untrackedGroups: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([directory, count]) => ({ directory, count })),
    risks, riskCount, truncated, warnings
  };
}
