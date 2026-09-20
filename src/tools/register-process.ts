import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { ProcessRuntime } from "../process/runtime.js";
import { PROCESS_STATES } from "../process/types.js";
import { structuredResult } from "./result.js";

const processStateSchema = z.enum(PROCESS_STATES);

const processSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  mode: z.enum(["command", "terminal"]),
  state: processStateSchema,
  pid: z.number().int().positive().optional(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  recoveryHint: z.enum(["none", "inspect", "retry"]),
  bufferedEvents: z.number().int().nonnegative()
});

const outputEventSchema = z.object({
  seq: z.number().int().positive(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
  timestamp: z.string()
});

export function registerProcessTools(
  exposer: Exposer,
  processRuntime: ProcessRuntime
): void {
  exposer.expose("process_start", {
    description: "Start a managed command or persistent PowerShell terminal session in the active workspace.",
    inputSchema: z.object({
      mode: z.enum(["command", "terminal"]).optional(),
      command: z.string().optional(),
      cwd: z.string().min(1).optional()
    }),
    outputSchema: processSessionSchema
  }, async ({ mode, command, cwd }) => {
    const session = await processRuntime.start({
      mode: mode ?? "command",
      command,
      cwd
    });
    return structuredResult(session);
  });

  exposer.expose("process_input", {
    description: "Write stdin to a running process session owned by the active workspace.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      input: z.string(),
      append_newline: z.boolean().optional()
    }),
    outputSchema: processSessionSchema
  }, async ({ session_id, input, append_newline }) => {
    const session = await processRuntime.input(
      session_id,
      input,
      append_newline ?? true
    );
    return structuredResult(session);
  });

  exposer.expose("process_output", {
    description: "Read bounded incremental stdout/stderr events from a managed process session.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      max_chars: z.number().int().min(1).max(65536).optional()
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      workspaceId: z.string(),
      state: processStateSchema,
      events: z.array(outputEventSchema),
      nextCursor: z.number().int().nonnegative(),
      truncated: z.boolean(),
      exitCode: z.number().int().nullable().optional()
    })
  }, async ({ session_id, cursor, max_chars }) => {
    const output = processRuntime.output(
      session_id,
      cursor ?? 0,
      max_chars ?? 65536
    );
    return structuredResult(output);
  });

  exposer.expose("process_status", {
    description: "List managed process sessions for the active workspace, or inspect one session.",
    inputSchema: z.object({
      session_id: z.string().min(1).optional()
    }),
    outputSchema: z.object({
      sessions: z.array(processSessionSchema)
    })
  }, async ({ session_id }) => {
    const sessions = session_id
      ? [processRuntime.view(session_id)]
      : processRuntime.list();
    return structuredResult({ sessions });
  });

  exposer.expose("process_wait", {
    description: "Wait for a managed process session for up to 60 seconds.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      timeout_ms: z.number().int().min(0).max(60000).optional()
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      state: processStateSchema,
      completed: z.boolean(),
      exitCode: z.number().int().nullable().optional()
    })
  }, async ({ session_id, timeout_ms }) => {
    const result = await processRuntime.wait(
      session_id,
      timeout_ms ?? 30000
    );
    return structuredResult(result);
  });

  exposer.expose("process_stop", {
    description: "Stop a managed process session in the active workspace; force=true kills the full process tree.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      force: z.boolean().optional()
    }),
    outputSchema: processSessionSchema
  }, async ({ session_id, force }) => {
    const session = await processRuntime.stop(session_id, force ?? false);
    return structuredResult(session);
  });
}
