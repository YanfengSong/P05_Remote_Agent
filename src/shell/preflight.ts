import fs from "node:fs/promises";
import { trustedApprovalModeEnabled } from "../policy/approval-mode.js";
import { assertAccessiblePath, assertSafeCommand } from "../security.js";
import { catastrophicShellReason } from "./policy.js";

export async function preflightShellExecution(
  command: string,
  workspaceRoot: string,
  cwd?: string
): Promise<{ safeCwd: string }> {
  const requestedCwd = cwd ?? workspaceRoot;

  if (trustedApprovalModeEnabled()) {
    const denied = catastrophicShellReason(command, workspaceRoot, requestedCwd);
    if (denied) throw new Error(`Command blocked by catastrophic safety policy: ${denied}`);
  } else {
    assertSafeCommand(command);
  }

  const safeCwd = await assertAccessiblePath(
    requestedCwd,
    "read",
    workspaceRoot,
    workspaceRoot
  );

  const stat = await fs.stat(safeCwd);
  if (!stat.isDirectory()) {
    throw new Error("Shell working directory is not a directory.");
  }

  return { safeCwd };
}
