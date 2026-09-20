export type DownstreamWorkspaceBinding = "active" | "platform" | "fixed";

export type DownstreamWorkspaceContext = {
  active: { id: string; root: string };
  platform: { id: string; root: string };
};

export type DownstreamDefinition = {
  id: string;
  label: string;
  /** Owning application plugin; undefined only for core/internal downstreams. */
  pluginId?: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  workspaceBinding?: DownstreamWorkspaceBinding;
  /** Used only when workspaceBinding=fixed. */
  cwd?: string;
  env?: Record<string, string>;
};

export type DownstreamStatus = {
  id: string;
  label: string;
  pluginId?: string;
  available: boolean;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  workspaceBinding: DownstreamWorkspaceBinding;
  boundWorkspaceId?: string;
  lastError?: string;
};

export type DownstreamTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ResolvedDownstreamTarget = {
  cwd?: string;
  workspaceId?: string;
  bindingKey: string;
};

export function resolveDownstreamTarget(
  definition: DownstreamDefinition,
  context: DownstreamWorkspaceContext
): ResolvedDownstreamTarget {
  const binding = definition.workspaceBinding ?? "active";
  switch (binding) {
    case "active":
      return {
        cwd: context.active.root,
        workspaceId: context.active.id,
        bindingKey: `active:${context.active.id}:${context.active.root}`
      };
    case "platform":
      return {
        cwd: context.platform.root,
        workspaceId: context.platform.id,
        bindingKey: `platform:${context.platform.id}:${context.platform.root}`
      };
    case "fixed":
      if (!definition.cwd) {
        throw new Error(`Downstream "${definition.id}" fixed workspace binding requires cwd.`);
      }
      return {
        cwd: definition.cwd,
        bindingKey: `fixed:${definition.cwd}`
      };
  }
}