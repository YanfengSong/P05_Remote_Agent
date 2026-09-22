import type { DownstreamDefinition } from "../downstream/types.js";
import type { DownstreamRegistry } from "../downstream/registry.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginContext } from "./types.js";

export type PluginState = "disabled" | "ready" | "running" | "failed" | "stopped";

export type PluginView = {
  id: string;
  label: string;
  version: string;
  apiVersion: string;
  enabled: boolean;
  state: PluginState;
  activeForWorkspace: boolean;
  capabilityNames: string[];
  downstreamIds: string[];
  lastError?: string;
};

export class PluginRuntime {
  readonly #state = new Map<string, { state: PluginState; lastError?: string }>();

  constructor(
    readonly registry: PluginRegistry,
    readonly workspaceManager: WorkspaceManager
  ) {
    for (const plugin of registry.plugins()) {
      this.#state.set(plugin.manifest.id, {
        state: plugin.manifest.enabled ? "ready" : "disabled"
      });
    }
  }

  isAllowedForCurrentWorkspace(pluginId: string): boolean {
    const plugin = this.registry.get(pluginId);
    if (!plugin.manifest.enabled) return false;
    const state = this.#state.get(pluginId)?.state;
    if (state === "failed" || state === "disabled" || state === "stopped") return false;
    return this.workspaceManager.pluginAllowed(pluginId);
  }

  assertAllowedForCurrentWorkspace(pluginId: string): void {
    if (!this.isAllowedForCurrentWorkspace(pluginId)) {
      throw new Error(
        `Plugin "${pluginId}" is not enabled for workspace "${this.workspaceManager.current().id}".`
      );
    }
  }

  downstreamAllowed(definition: DownstreamDefinition): boolean {
    return !definition.pluginId || this.isAllowedForCurrentWorkspace(definition.pluginId);
  }

  private pluginContext(
    pluginId: string,
    downstreamRegistry?: DownstreamRegistry
  ): PluginContext {
    const ownedDownstreams = new Set(
      this.registry
        .downstreamDefinitions()
        .filter((definition) => definition.pluginId === pluginId)
        .map((definition) => definition.id)
    );

    const assertOwnedDownstream = (serverId: string): void => {
      if (!ownedDownstreams.has(serverId)) {
        throw new Error(
          `Plugin "${pluginId}" cannot access downstream MCP "${serverId}" because it does not own it.`
        );
      }
    };

    return {
      workspace: {
        current: () => {
          const current = this.workspaceManager.current();
          return {
            id: current.id,
            root: current.root,
            kind: current.kind,
            ...(current.label ? { label: current.label } : {}),
            platform: current.kind === "platform-source"
          };
        },
        root: () => this.workspaceManager.currentRoot()
      },
      ...(downstreamRegistry
        ? {
            downstream: {
              listTools: async (serverId: string) => {
                assertOwnedDownstream(serverId);
                return downstreamRegistry.listTools(serverId);
              },
              callTool: async (
                serverId: string,
                tool: string,
                args: Record<string, unknown> = {}
              ) => {
                assertOwnedDownstream(serverId);
                return downstreamRegistry.callTool(serverId, tool, args);
              }
            }
          }
        : {})
    };
  }

  registerTools(exposer: Exposer, downstreamRegistry?: DownstreamRegistry): void {
    for (const plugin of this.registry.plugins()) {
      if (!plugin.manifest.enabled) continue;

      const context = this.pluginContext(
        plugin.manifest.id,
        downstreamRegistry
      );

      for (const tool of plugin.tools ?? []) {
        (
          exposer.expose as unknown as (
            name: string,
            config: unknown,
            handler: (args: Record<string, unknown>) => Promise<unknown>
          ) => void
        )(
          tool.name,
          {
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {})
          },
          async (args: Record<string, unknown>) => {
            this.assertAllowedForCurrentWorkspace(plugin.manifest.id);
            return tool.handler(args ?? {}, context);
          }
        );
      }

      if (!plugin.registerTools) continue;

      const guardedExposer: Exposer = {
        expose: ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
          (exposer.expose as unknown as (
            name: string,
            config: unknown,
            handler: (...args: unknown[]) => unknown
          ) => void)(
            name,
            config,
            async (...args: unknown[]) => {
              this.assertAllowedForCurrentWorkspace(plugin.manifest.id);
              return handler(...args);
            }
          );
        }) as Exposer["expose"],
        report: () => exposer.report()
      };

      plugin.registerTools(guardedExposer, {
        workspaceManager: this.workspaceManager,
        ...(downstreamRegistry ? { downstreamRegistry } : {})
      });
    }
  }

  async start(pluginId: string): Promise<PluginView> {
    const plugin = this.registry.get(pluginId);
    if (!plugin.manifest.enabled) {
      throw new Error(`Plugin "${pluginId}" is disabled by configuration.`);
    }

    if (this.#state.get(pluginId)?.state === "running") {
      return this.view(pluginId);
    }

    try {
      await plugin.start?.();
      this.#state.set(pluginId, { state: "running" });
      return this.view(pluginId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.set(pluginId, { state: "failed", lastError: "start failed" });
      throw new Error(`Plugin "${pluginId}" failed to start: ${message}`);
    }
  }

  async stop(
    pluginId: string,
    downstreamRegistry?: DownstreamRegistry
  ): Promise<PluginView> {
    const plugin = this.registry.get(pluginId);
    if (!plugin.manifest.enabled) {
      throw new Error(`Plugin "${pluginId}" is disabled by configuration.`);
    }

    if (this.#state.get(pluginId)?.state === "stopped") {
      return this.view(pluginId);
    }

    try {
      await plugin.stop?.();
      if (downstreamRegistry) {
        for (const definition of this.registry.downstreamDefinitions()) {
          if (definition.pluginId === pluginId) {
            await downstreamRegistry.close(definition.id);
          }
        }
      }
      this.#state.set(pluginId, { state: "stopped" });
      return this.view(pluginId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.set(pluginId, { state: "failed", lastError: "stop failed" });
      throw new Error(`Plugin "${pluginId}" failed to stop: ${message}`);
    }
  }

  async startAll(): Promise<void> {
    for (const plugin of this.registry.plugins()) {
      if (!plugin.manifest.enabled) continue;
      try {
        await this.start(plugin.manifest.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[p05] plugin "${plugin.manifest.id}" start failed: ${message}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.registry.plugins()) {
      if (!plugin.manifest.enabled) continue;
      try {
        await this.stop(plugin.manifest.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[p05] plugin "${plugin.manifest.id}" stop failed: ${message}`);
      }
    }
  }

  private view(pluginId: string): PluginView {
    const plugin = this.registry.get(pluginId);
    const downstream = this.registry.downstreamDefinitions();
    const state = this.#state.get(pluginId) ?? { state: "failed" as const, lastError: "state missing" };
    return {
      id: plugin.manifest.id,
      label: plugin.manifest.label,
      version: plugin.manifest.version,
      apiVersion: plugin.manifest.apiVersion,
      enabled: plugin.manifest.enabled,
      state: state.state,
      activeForWorkspace: this.isAllowedForCurrentWorkspace(plugin.manifest.id),
      capabilityNames: plugin.manifest.capabilities.map((entry) => entry.name),
      downstreamIds: downstream
        .filter((definition) => definition.pluginId === plugin.manifest.id)
        .map((definition) => definition.id),
      ...(state.lastError ? { lastError: state.lastError } : {})
    };
  }

  list(): PluginView[] {
    return this.registry.plugins().map((plugin) => this.view(plugin.manifest.id));
  }
}