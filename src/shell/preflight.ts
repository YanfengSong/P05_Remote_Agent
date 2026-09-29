import fs from "node:fs/promises";
import { assertAccessiblePath, assertSafeCommand } from "../security.js";

export async function preflightShellExecution(
  command: string,
  workspaceRoot: string,
  cwd?: string
): Promise<{ safeCwd: string }> {
  assertSafeCommand(command);

  const requestedCwd = cwd ?? workspaceRoot;
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
