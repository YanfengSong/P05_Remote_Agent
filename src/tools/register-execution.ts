import * as z from "zod/v4";
import { config } from "../config.js";
import type { Exposer } from "../policy/expose.js";
import { assertAccessiblePath } from "../security.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { PROJECT_VALIDATION_ACTIONS, runDeveloperAction } from "./dev-command.js";
import { requestRuntimeRestart } from "./runtime.js";
import { runPowerShell } from "./shell.js";
import {
  REMOTE_READ_OPERATIONS,
  REMOTE_READ_TARGETS,
  runRemoteRead
} from "./remote-read.js";
import { structuredResult } from "./result.js";

const MAX_PROJECT_VALIDATION_OUTPUT_BYTES = 256 * 1024;

function boundedValidationOutput(value: string, remainingBytes: number): string {
  if (remainingBytes <= 0) return "[OUTPUT OMITTED: aggregate validation output limit reached]";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= remainingBytes) return value;
  const marker = "\n[TRUNCATED: aggregate validation output limit reached]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (remainingBytes <= markerBytes) {
    return buffer.subarray(0, remainingBytes).toString("utf8");
  }
  const payloadLimit = remainingBytes - markerBytes;
  return buffer.subarray(0, payloadLimit).toString("utf8") + marker;
}


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

  exposer.expose("project_validate", {
    description:
      "Run multiple named, allowlisted P05 platform validation checks sequentially in one call. Prefer this over repeated command_run calls for independent checks. Only fixed check names are accepted; arbitrary commands and arguments are not. Requires the normal one-time approval because it executes build/test code, stops at the first failure, and caps aggregate output at 256 KiB.",
    inputSchema: z.object({
      checks: z.array(z.enum(PROJECT_VALIDATION_ACTIONS))
        .min(1)
        .max(PROJECT_VALIDATION_ACTIONS.length)
        .refine((items) => new Set(items).size === items.length, "checks must not contain duplicates")
    }),
    outputSchema: z.object({
      status: z.enum(["passed", "failed"]),
      requestedChecks: z.array(z.enum(PROJECT_VALIDATION_ACTIONS)),
      completedChecks: z.number().int().nonnegative(),
      stoppedEarly: z.boolean(),
      results: z.array(z.object({
        name: z.enum(PROJECT_VALIDATION_ACTIONS),
        status: z.enum(["passed", "failed"]),
        output: z.string()
      }))
    })
  }, async ({ checks }) => {
    const platformRoot = workspaceManager.platformRoot();
    const results: Array<{
      name: typeof PROJECT_VALIDATION_ACTIONS[number];
      status: "passed" | "failed";
      output: string;
    }> = [];
    let remainingBytes = MAX_PROJECT_VALIDATION_OUTPUT_BYTES;

    for (const action of checks) {
      try {
        const output = await runDeveloperAction(action, platformRoot);
        const bounded = boundedValidationOutput(output, remainingBytes);
        remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(bounded, "utf8"));
        results.push({ name: action, status: "passed", output: bounded });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Validation failed.";
        const bounded = boundedValidationOutput(message, remainingBytes);
        results.push({ name: action, status: "failed", output: bounded });
        break;
      }
    }

    const result = {
      status: results.every((entry) => entry.status === "passed") ? "passed" as const : "failed" as const,
      requestedChecks: checks,
      completedChecks: results.length,
      stoppedEarly: results.length < checks.length,
      results
    };
    const summary = "P05 validation " + result.status + ": completed " +
      result.completedChecks + " of " + checks.length + " checks" +
      (result.stoppedEarly ? "; stopped at first failure." : ".");
    return structuredResult(result, summary);
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

  exposer.expose("remote_read", {
    description:
      "Run a fixed read-only maintenance query against configured H1/J1 SSH targets. The caller selects only target and operation; host, user, identity files and remote command text are local configuration.",
    inputSchema: z.object({
      target: z.enum(REMOTE_READ_TARGETS),
      operation: z.enum(REMOTE_READ_OPERATIONS)
    }),
    outputSchema: z.object({
      target: z.enum(REMOTE_READ_TARGETS),
      operation: z.enum(REMOTE_READ_OPERATIONS),
      stdout: z.string(),
      stderr: z.string()
    })
  }, async ({ target, operation }) => {
    const result = await runRemoteRead(target, operation);
    const output = {
      target,
      operation,
      stdout: result.stdout,
      stderr: result.stderr
    };
    return structuredResult(
      output,
      "STDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr
    );
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
