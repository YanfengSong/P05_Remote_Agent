import * as z from "zod/v4";
import type { AuditStore } from "../audit/store.js";
import { ERROR_CATEGORIES } from "../runtime/errors.js";
import type { Exposer } from "../policy/expose.js";
import type { PluginRuntime } from "../plugin/runtime.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { structuredResult } from "./result.js";

const authorizationSchema = z.object({
  structuredCrossWorkspace: z.literal("deny"),
  externalPersistentWrite: z.literal("approval-required"),
  shellBoundary: z.literal("trusted-user")
});

const workspaceViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["platform-source", "git-project", "generic"]),
  label: z.string().optional(),
  current: z.boolean(),
  platform: z.boolean(),
  plugins: z.array(z.string()).optional(),
  authorization: authorizationSchema
});

const workspaceCurrentSchema = z.object({
  id: z.string(),
  kind: z.enum(["platform-source", "git-project", "generic"]),
  label: z.string().optional(),
  platform: z.boolean(),
  authorization: authorizationSchema
});

const auditEventSchema = z.object({
  id: z.string(),
  capability: z.string(),
  scope: z.enum(["platform", "workspace", "downstream", "host", "external", "temporary"]),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  actorType: z.enum(["interactive", "agent", "plugin", "system"]).optional(),
  actorId: z.string().optional(),
  taskId: z.string().optional(),
  state: z.enum(["running", "succeeded", "failed"]),
  phase: z.enum(["prepare", "authorize", "execute", "verify", "complete"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  errorCategory: z.enum(ERROR_CATEGORIES).optional(),
  recoveryHint: z.enum(["none", "retry", "inspect", "human"])
});

const pluginViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  version: z.string(),
  apiVersion: z.string(),
  enabled: z.boolean(),
  state: z.enum(["disabled", "ready", "running", "failed", "stopped"]),
  activeForWorkspace: z.boolean(),
  capabilityNames: z.array(z.string()),
  downstreamIds: z.array(z.string()),
  agentProviderIds: z.array(z.string()),
  lastError: z.string().optional()
});

export function registerControlTools(
  exposer: Exposer,
  workspaceManager: WorkspaceManager,
  auditStore: AuditStore,
  pluginRuntime: PluginRuntime
): void {
  exposer.expose("workspace_list", {
    description: "List registered workspaces by logical id. Host paths are not returned.",
    inputSchema: z.object({}),
    outputSchema: z.object({ workspaces: z.array(workspaceViewSchema) })
  }, async () => {
    const workspaces = workspaceManager.list();
    return structuredResult({ workspaces }, JSON.stringify(workspaces, null, 2));
  });

  exposer.expose("workspace_current", {
    description: "Show the active workspace identity and authorization semantics without host paths.",
    inputSchema: z.object({}),
    outputSchema: workspaceCurrentSchema
  }, async () => {
    const current = workspaceManager.current();
    const output = {
      id: current.id,
      kind: current.kind,
      ...(current.label ? { label: current.label } : {}),
      platform: current.kind === "platform-source",
      authorization: current.authorization
    };
    return structuredResult(output);
  });

  exposer.expose("workspace_switch", {
    description: "Switch the active session workspace by registered workspace id only.",
    inputSchema: z.object({ workspace_id: z.string().min(1) }),
    outputSchema: workspaceViewSchema
  }, async ({ workspace_id }) => {
    const output = workspaceManager.switch(workspace_id);
    return structuredResult(output);
  });

  exposer.expose("activity_recent", {
    description: "Show recent execution metadata. Inputs, file content and command text are not stored.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    outputSchema: z.object({ events: z.array(auditEventSchema) })
  }, async ({ limit }) => {
    const events = auditStore.recent(limit ?? 20);
    return structuredResult({ events }, JSON.stringify(events, null, 2));
  });

  exposer.expose("plugin_list", {
    description: "List installed application plugins and availability for the active workspace.",
    inputSchema: z.object({}),
    outputSchema: z.object({ plugins: z.array(pluginViewSchema) })
  }, async () => {
    const plugins = pluginRuntime.list();
    return structuredResult({ plugins }, JSON.stringify(plugins, null, 2));
  });

  exposer.expose("recovery_status", {
    description: "Show failed or interrupted executions that may need recovery.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    outputSchema: z.object({ events: z.array(auditEventSchema) })
  }, async ({ limit }) => {
    const events = auditStore.recovery(limit ?? 20);
    return structuredResult({ events }, JSON.stringify(events, null, 2));
  });
}
