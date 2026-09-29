import { setupV3 } from "./v3/setup.js";

const [stateDir, workspaceRoot, slotId, principal, ...extra] = process.argv.slice(2);
try {
  if (!stateDir || !workspaceRoot || !principal || !["A", "B"].includes(slotId) || extra.length) throw new Error("Usage: v3-setup <new-absolute-state-dir> <existing-workspace> <A|B> <principal>");
  const result = await setupV3({ stateDir, workspaceRoot, slotId: slotId as "A" | "B", principal });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(error instanceof Error && error.message.startsWith("Usage:") ? error.message + "\n" : "Setup failed. The state directory must be new, local, outside the workspace, with an existing parent. Inspect any newly created directory before retrying.\n");
  process.exitCode = 1;
}
