import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_RESTART_BROKER_TASK_NAME = "P05-RestartBroker";

function readOwnEnv(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : undefined;
}

export function restartBrokerTaskName(
  raw = readOwnEnv("P05_OPERATOR_RESTART_TASK")
): string {
  const value = raw?.trim() || DEFAULT_RESTART_BROKER_TASK_NAME;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(
      "P05_OPERATOR_RESTART_TASK must be a simple Scheduled Task name containing only letters, digits, dot, underscore or hyphen."
    );
  }
  return value;
}

export function runtimeRestartInvocation(): { executable: string; args: readonly string[] } {
  return {
    executable: "schtasks.exe",
    args: ["/Run", "/TN", restartBrokerTaskName()]
  };
}

export async function requestRuntimeRestart(): Promise<string> {
  const invocation = runtimeRestartInvocation();
  const taskName = invocation.args[2] ?? DEFAULT_RESTART_BROKER_TASK_NAME;
  try {
    await execFileAsync(invocation.executable, [...invocation.args], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  } catch {
    throw new Error(
      `Could not start the configured P05 restart broker (${taskName}). Ensure the task is provisioned and runnable.`
    );
  }

  return "RESTART_SCHEDULED: configured P05 restart broker started.";
}
