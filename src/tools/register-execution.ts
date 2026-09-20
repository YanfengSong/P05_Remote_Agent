import * as z from "zod/v4";
import { config } from "../config.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { runDeveloperAction } from "./dev-command.js";
import { requestRuntimeRestart } from "./runtime.js";
import { runPowerShell } from "./shell.js";
import { structuredResult } from "./result.js";

export function registerExecutionTools(exposer: Exposer, workspaceManager: WorkspaceManager): void {
  exposer.expose("command_run", {
    description: "Run a named P05 platform validation action. It always targets the platform-source workspace.",
    inputSchema: z.object({ action: z.string().min(1) }),
    outputSchema: z.object({
      action: z.string(),
      output: z.string()
    })
  }, async ({ action }) => {
    const output = await runDeveloperAction(action, workspaceManager.platformRoot());
    return structuredResult({ action, output }, output);
  });

  exposer.expose("runtime_restart", {
    description: "Restart only the provisioned P05 runtime. No command, path or arguments are accepted.",
    inputSchema: z.object({}),
    outputSchema: z.object({ status: z.string() })
  }, async () => {
    const status = await requestRuntimeRestart();
    return structuredResult({ status }, status);
  });

  exposer.expose("shell_run", {
    description: "Run PowerShell starting inside the active workspace; command authority remains trusted-user.",
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional()
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      cwd: z.string().optional()
    })
  }, async ({ command, cwd, timeoutMs }) => {
    const result = await runPowerShell(
      command,
      workspaceManager.currentRoot(),
      cwd,
      timeoutMs ?? config.shellTimeoutMs
    );
    const output = {
      stdout: result.stdout,
      stderr: result.stderr,
      ...(cwd ? { cwd } : {})
    };
    const header = cwd ? `cwd: ${cwd}\n` : "";
    return structuredResult(
      output,
      header + "STDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr
    );
  });
}
