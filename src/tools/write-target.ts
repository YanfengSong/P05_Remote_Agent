import fs from "node:fs/promises";
import { assertAccessiblePath } from "../security.js";

export async function assertWorkspaceWriteTarget(
  input: string,
  workspaceRoot: string
): Promise<void> {
  const safe = await assertAccessiblePath(
    input,
    "write",
    workspaceRoot,
    workspaceRoot
  );

  try {
    const stat = await fs.lstat(safe);
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(
        "Write refused: target has multiple hard links and cannot be proven Workspace-local."
      );
    }
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return;
    throw error;
  }
}
