import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
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

export function registerWorkspaceReadTools(
  exposer: Exposer,
  workspaceManager: WorkspaceManager
): void {
  exposer.expose("workspace_list", {
    description: "Read-only inventory of registered workspace identities. This tool does NOT switch, bind or authorize a workspace. Host paths are not returned.",
    inputSchema: z.object({}),
    outputSchema: z.object({ workspaces: z.array(workspaceViewSchema) })
  }, async () => {
    const workspaces = workspaceManager.list();
    return structuredResult({ workspaces }, JSON.stringify(workspaces, null, 2));
  });

  exposer.expose("workspace_current", {
    description: "Read the currently active workspace identity and authorization semantics. This tool is read-only and does NOT switch or rebind the workspace. For reviewer tasks, call review_context first for a fresh snapshot.",
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
}
