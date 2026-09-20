import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RESTART_BROKER_TASK_NAME = "P05-RestartBroker";

export function runtimeRestartInvocation(): { executable: string; args: readonly string[] } {
  return {
    executable: "schtasks.exe",
    args: ["/Run", "/TN", RESTART_BROKER_TASK_NAME]
  };
}

/**
 * Trigger the pre-provisioned external restart broker.
 *
 * The broker task is installed once by an administrator outside the Agent writable
 * workspace. The MCP caller cannot supply a task name, command, path or arguments.
 * This keeps restart authority external to the self-modifying Agent.
 */
export async function requestRuntimeRestart(): Promise<string> {
  const invocation = runtimeRestartInvocation();
  try {
    await execFileAsync(invocation.executable, [...invocation.args], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  } catch {
    throw new Error(
      "Could not start the external P05 restart broker. Ensure P05-RestartBroker is provisioned and runnable."
    );
  }

  return "RESTART_SCHEDULED: external P05 restart broker started.";
}
