import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  gitAdd,
  gitBranch,
  gitCommit,
  gitDiff,
  gitDiffStat,
  gitPush,
  gitStatus
} from "./git.js";
import { structuredResult } from "./result.js";

const gitTextOutput = z.object({ output: z.string() });

function gitResult(output: string) {
  return structuredResult({ output }, output);
}

export function registerGitTools(exposer: Exposer, workspaceManager: WorkspaceManager): void {
  exposer.expose("git_status", {
    description: "Show repository branch and working-tree status for the active workspace.",
    inputSchema: z.object({}),
    outputSchema: gitTextOutput
  }, async () => gitResult(await gitStatus(workspaceManager.currentRoot())));

  exposer.expose("git_diff", {
    description: "Show repository diff; set staged=true for the index diff.",
    inputSchema: z.object({ staged: z.boolean().optional() }),
    outputSchema: gitTextOutput
  }, async ({ staged }) => gitResult(
    await gitDiff(workspaceManager.currentRoot(), Boolean(staged))
  ));

  exposer.expose("git_diff_stat", {
    description: "Show compact repository diff statistics; set staged=true for the index.",
    inputSchema: z.object({ staged: z.boolean().optional() }),
    outputSchema: gitTextOutput
  }, async ({ staged }) => gitResult(
    await gitDiffStat(workspaceManager.currentRoot(), Boolean(staged))
  ));

  exposer.expose("git_add", {
    description: "Stage 1..200 explicit paths inside the active workspace. Git pathspec magic is refused.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1)).min(1).max(200)
    }),
    outputSchema: gitTextOutput
  }, async ({ paths }) => gitResult(
    await gitAdd(workspaceManager.currentRoot(), paths)
  ));

  exposer.expose("git_commit", {
    description: "Create a local commit in the active workspace from the current index.",
    inputSchema: z.object({
      message: z.string().min(1).max(4096)
    }),
    outputSchema: gitTextOutput
  }, async ({ message }) => gitResult(
    await gitCommit(workspaceManager.currentRoot(), message)
  ));

  exposer.expose("git_branch", {
    description: "Create, switch or safely delete a local branch. Force delete is not supported.",
    inputSchema: z.object({
      action: z.enum(["create", "switch", "delete"]),
      name: z.string().min(1).max(255)
    }),
    outputSchema: gitTextOutput
  }, async ({ action, name }) => gitResult(
    await gitBranch(workspaceManager.currentRoot(), action, name)
  ));

  exposer.expose("git_push", {
    description: "Push current HEAD to a named remote. Force and arbitrary refspecs are not supported.",
    inputSchema: z.object({
      remote: z.string().min(1).max(64).optional(),
      set_upstream: z.boolean().optional()
    }),
    outputSchema: gitTextOutput
  }, async ({ remote, set_upstream }) => gitResult(
    await gitPush(
      workspaceManager.currentRoot(),
      remote ?? "origin",
      Boolean(set_upstream)
    )
  ));
}
