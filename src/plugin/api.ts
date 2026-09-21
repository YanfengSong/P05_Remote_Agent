import type { CapabilityDescriptor } from "../capability/types.js";
import type {
  DownstreamDefinition,
  DownstreamWorkspaceBinding
} from "../downstream/types.js";
import { structuredResult } from "../tools/result.js";
import {
  PLUGIN_API_VERSION,
  type ApplicationPlugin,
  type PluginContext,
  type PluginDependency,
  type PluginManifest,
  type PluginPermissionDeclaration,
  type PluginToolDefinition,
  type PluginWorkspaceSnapshot
} from "./types.js";

export {
  PLUGIN_API_VERSION,
  type ApplicationPlugin,
  type CapabilityDescriptor,
  type DownstreamDefinition,
  type DownstreamWorkspaceBinding,
  type PluginContext,
  type PluginDependency,
  type PluginManifest,
  type PluginPermissionDeclaration,
  type PluginToolDefinition,
  type PluginWorkspaceSnapshot
};

/**
 * Public Plugin API v1 entry helper.
 *
 * It deliberately does not mutate or auto-register anything. Registration and
 * authorization remain owned by P05 Core.
 */
export function definePlugin<const T extends ApplicationPlugin>(plugin: T): T {
  return plugin;
}

/**
 * Public Plugin API v1 declarative tool helper.
 */
export function defineTool<
  Args extends Record<string, unknown> = Record<string, unknown>
>(tool: PluginToolDefinition<Args>): PluginToolDefinition<Args> {
  return tool;
}

/**
 * Public Plugin API v1 downstream MCP declaration helper.
 */
export function defineDownstream<const T extends DownstreamDefinition>(
  definition: T
): T {
  return definition;
}

/**
 * Standard structured MCP result helper for plugins.
 */
export const pluginResult = structuredResult;
