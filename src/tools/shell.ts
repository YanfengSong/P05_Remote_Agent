import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertAccessiblePath, assertSafeCommand } from "../security.js";

const execFileAsync = promisify(execFile);

/**
 * Returns stdout/stderr only.
 *
 * The resolved working directory is deliberately not returned: when the caller omits
 * `cwd` it is the active workspace root, an absolute machine path, and a successful response
 * that echoed it would hand the remote the agent's own working directory. The caller
 * echoes its own `cwd` argument instead when it supplied one.
 */
export async function runPowerShell(
  command: string,
  workspaceRoot: string,
  cwd?: string,
  timeoutMs = 120000
): Promise<{ stdout: string; stderr: string }> {
  assertSafeCommand(command);
  // The working directory goes through the same guard as the fs tools. A string-only
  // check let a junction in the allowed root run the command outside it, which the
  // README's "runs in an allowed working directory" claim then contradicted.
  // Note: this constrains where the command starts, not what it may then write —
  // shell_run is not a sandbox.
  const requestedCwd = cwd ?? workspaceRoot;
  const safeCwd = await assertAccessiblePath(requestedCwd, "read", workspaceRoot, workspaceRoot);
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: safeCwd,
        timeout: Math.min(Math.max(timeoutMs, 1000), 10 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    return { stdout, stderr };
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? error?.message ?? String(error);
    throw new Error(`Process failed.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
}