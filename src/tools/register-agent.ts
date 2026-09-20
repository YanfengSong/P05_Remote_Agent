import * as z from "zod/v4";
import type { AgentRuntime } from "../agent/runtime.js";
import type { Exposer } from "../policy/expose.js";
import { SESSION_STATES } from "../session/types.js";
import { structuredResult } from "./result.js";

const agentProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  pluginId: z.string(),
  enabled: z.boolean(),
  activeForWorkspace: z.boolean(),
  writeAccess: z.boolean()
});

const agentSessionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  workspaceId: z.string(),
  state: z.enum(SESSION_STATES),
  actorId: z.string(),
  isolationId: z.string().optional(),
  isolationKind: z.enum(["workspace", "worktree", "session-root"]).optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  lastActivityAt: z.string(),
  finishedAt: z.string().optional(),
  recoveryHint: z.enum(["none", "inspect", "retry"]),
  taskCount: z.number().int().nonnegative()
});

const agentEventSchema = z.object({
  seq: z.number().int().positive(),
  channel: z.string(),
  text: z.string(),
  timestamp: z.string()
});

export function registerAgentTools(
  exposer: Exposer,
  agentRuntime: AgentRuntime
): void {
  exposer.expose("agent_list", {
    description: "List Agent Providers and Agent sessions visible in the active workspace.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      providers: z.array(agentProviderSchema),
      sessions: z.array(agentSessionSchema)
    })
  }, async () => {
    const output = {
      providers: agentRuntime.providers(),
      sessions: agentRuntime.sessions()
    };
    return structuredResult(output);
  });

  exposer.expose("agent_start", {
    description: "Start an Agent session through a registered provider. Writing providers require worktree isolation.",
    inputSchema: z.object({
      provider: z.string().min(1)
    }),
    outputSchema: agentSessionSchema
  }, async ({ provider }) => {
    const session = await agentRuntime.start(provider);
    return structuredResult(session);
  });

  exposer.expose("agent_task", {
    description: "Submit a task payload to a running Agent session. Task text is not persisted by Core.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      task: z.string().min(1)
    }),
    outputSchema: agentSessionSchema
  }, async ({ session_id, task }) => {
    const session = await agentRuntime.task(session_id, task);
    return structuredResult(session);
  });

  exposer.expose("agent_status", {
    description: "Inspect one Agent session or all Agent sessions in the active workspace.",
    inputSchema: z.object({
      session_id: z.string().min(1).optional()
    }),
    outputSchema: z.object({ sessions: z.array(agentSessionSchema) })
  }, async ({ session_id }) => {
    const sessions = session_id
      ? [await agentRuntime.status(session_id)]
      : agentRuntime.sessions();
    return structuredResult({ sessions });
  });

  exposer.expose("agent_output", {
    description: "Read bounded incremental output from a running Agent Provider.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      max_chars: z.number().int().min(1).max(65536).optional()
    }),
    outputSchema: z.object({
      agentSessionId: z.string(),
      state: z.enum(SESSION_STATES),
      events: z.array(agentEventSchema),
      nextCursor: z.number().int().nonnegative(),
      truncated: z.boolean()
    })
  }, async ({ session_id, cursor, max_chars }) => {
    const output = await agentRuntime.output(
      session_id,
      cursor ?? 0,
      max_chars ?? 65536
    );
    return structuredResult(output);
  });

  exposer.expose("agent_stop", {
    description: "Stop a running Agent session. Unreconciled worktree results are preserved.",
    inputSchema: z.object({
      session_id: z.string().min(1),
      force: z.boolean().optional()
    }),
    outputSchema: agentSessionSchema
  }, async ({ session_id, force }) => {
    const session = await agentRuntime.stop(session_id, force ?? false);
    return structuredResult(session);
  });
}
