import type { AgentProvider } from "../agent/provider.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { DownstreamDefinition } from "../downstream/types.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";

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

export type PluginToolContext = {
  workspaceManager: WorkspaceManager;
};

export type ApplicationPlugin = {
  manifest: PluginManifest;
  downstreamDefinitions?: () => readonly DownstreamDefinition[];
  agentProviders?: () => readonly AgentProvider[];
  registerTools?: (exposer: Exposer, context: PluginToolContext) => void;
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};
