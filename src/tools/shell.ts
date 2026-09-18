import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { assertAllowedPath, assertSafeCommand } from "../security.js";

const execFileAsync = promisify(execFile);

export async function runPowerShell(
  command: string,
  cwd = config.defaultCwd,
  timeoutMs = config.shellTimeoutMs
): Promise<{ stdout: string; stderr: string; cwd: string }> {
  assertSafeCommand(command);
  const safeCwd = assertAllowedPath(cwd);
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
    return { stdout, stderr, cwd: safeCwd };
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? error?.message ?? String(error);
    throw new Error(`Process failed.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
}
