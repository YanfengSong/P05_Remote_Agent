import type { CapabilityDescriptor } from "../capability/types.js";
import type { DownstreamDefinition } from "../downstream/types.js";
import type { DownstreamRegistry } from "../downstream/registry.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { WorkspaceKind } from "../workspace/types.js";

export const PLUGIN_API_VERSION = "1" as const;

export type PluginPermissionDeclaration = {
  workspace: "active" | "platform" | "fixed";
  hostEffects: "none" | "broker-only" | "approval-required";
};

export type PluginDependency = {
  id: string;
  optional?: boolean;
};

export type PluginManifest = {
  id: string;
  label: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  enabled: boolean;
  capabilities: readonly CapabilityDescriptor[];
  permissions: PluginPermissionDeclaration;
  dependencies?: readonly PluginDependency[];
};

export type PluginWorkspaceSnapshot = {
  id: string;
  root: string;
  kind: WorkspaceKind;
  label?: string;
  platform: boolean;
};

export type PluginContext = {
  workspace: {
    current(): PluginWorkspaceSnapshot;
    root(): string;
  };
  downstream?: {
    listTools(serverId: string): Promise<unknown>;
    callTool(
      serverId: string,
      tool: string,
      args?: Record<string, unknown>
    ): Promise<unknown>;
  };
};

export type PluginToolDefinition<
  Args extends Record<string, unknown> = Record<string, unknown>
> = {
  name: string;
  description?: string;
  inputSchema?: StandardSchemaWithJSON;
  outputSchema?: StandardSchemaWithJSON;
  handler(
    args: Args,
    context: PluginContext
  ): unknown | Promise<unknown>;
};

/**
 * Legacy V2 registration context. New Plugin API v1 plugins should use
 * declarative tools[] and PluginContext instead.
 */
export type PluginToolContext = {
  workspaceManager: WorkspaceManager;
  downstreamRegistry?: DownstreamRegistry;
};

export type ApplicationPlugin = {
  manifest: PluginManifest;
  downstreamDefinitions?: () => readonly DownstreamDefinition[];

  /** Plugin API v1 declarative tool contributions. */
  tools?: readonly PluginToolDefinition[];

  /**
   * Legacy V2 imperative registration hook.
   * Kept temporarily so existing plugins can migrate without a flag day.
   */
  registerTools?: (exposer: Exposer, context: PluginToolContext) => void;

  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};
