import * as z from "zod/v4";
import { config } from "../config.js";
import type { Exposer } from "../policy/expose.js";
import { assertAccessiblePath } from "../security.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { runDeveloperAction } from "./dev-command.js";
import { requestRuntimeRestart } from "./runtime.js";
import { runPowerShell } from "./shell.js";
import { structuredResult } from "./result.js";

export function registerExecutionTools(
  exposer: Exposer,
  workspaceManager: WorkspaceManager
): void {
  exposer.expose("command_run", {
    description:
      "Run a named P05 platform validation action. Permission policy is evaluated before execution; the action always targets the platform-source workspace.",
    inputSchema: z.object({ action: z.string().min(1) }),
    outputSchema: z.object({
      action: z.string(),
      output: z.string()
    })
  }, async ({ action }) => {
    const output = await runDeveloperAction(
      action,
      workspaceManager.platformRoot()
    );
    return structuredResult({ action, output }, output);
  });

  exposer.expose("runtime_restart", {
    description:
      "Request restart of the current P05 Runtime slot. Permission policy is evaluated before the fixed repo-local restart controller is invoked.",
    inputSchema: z.object({}),
    outputSchema: z.object({ status: z.string() })
  }, async () => {
    const status = await requestRuntimeRestart();
    return structuredResult({ status }, status);
  });

  exposer.expose("shell_run", {
    description:
      "Run PowerShell after the common P05 Permission Broker authorizes the call.",
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional()
    }),
    outputSchema: z.object({
      status: z.literal("executed"),
      stdout: z.string(),
      stderr: z.string(),
      cwd: z.string().optional()
    })
  }, async ({ command, cwd, timeoutMs }) => {
    const workspaceRoot = workspaceManager.currentRoot();
    const requestedCwd = cwd ?? workspaceRoot;
    const safeCwd = await assertAccessiblePath(
      requestedCwd,
      "read",
      workspaceRoot,
      workspaceRoot
    );

    const result = await runPowerShell(
      command,
      workspaceRoot,
      safeCwd,
      timeoutMs ?? config.shellTimeoutMs
    );
    const output = {
      status: "executed" as const,
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
