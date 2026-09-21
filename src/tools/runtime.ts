import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");

function runtimeSlot(raw = process.env.P05_RUNTIME_SLOT): "A" | "B" {
  const value = raw?.trim().toUpperCase();
  if (value !== "A" && value !== "B") {
    throw new Error(
      "P05_RUNTIME_SLOT must be A or B for repo-local runtime restart."
    );
  }
  return value;
}

export function runtimeRestartInvocation(
  rawSlot = process.env.P05_RUNTIME_SLOT
): { executable: string; args: readonly string[] } {
  const slot = runtimeSlot(rawSlot);
  const script = path.join(
    repoRoot,
    "scripts",
    "deployment",
    "request-restart-runtime-slot.ps1"
  );
  return {
    executable: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Slot",
      slot
    ]
  };
}

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
      "Could not schedule the repo-local P05 runtime restart."
    );
  }

  return "RESTART_SCHEDULED: repo-local P05 runtime restart requested.";
}
