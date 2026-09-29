import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellEnv } from "../host/windows-powershell-env.js";
import { preflightShellExecution } from "../shell/preflight.js";

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
  timeoutMs = 90000
): Promise<{ stdout: string; stderr: string }> {
  const { safeCwd } = await preflightShellExecution(
    command,
    workspaceRoot,
    cwd
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: safeCwd,
        env: windowsPowerShellEnv(),
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
