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

  async startAll(): Promise<void> {
    for (const plugin of this.registry.plugins()) {
      if (!plugin.manifest.enabled) continue;
      try {
        await plugin.start?.();
        this.#state.set(plugin.manifest.id, { state: "running" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[p05] plugin "${plugin.manifest.id}" start failed: ${message}`);
        this.#state.set(plugin.manifest.id, { state: "failed", lastError: "start failed" });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.registry.plugins()) {
      try {
        await plugin.stop?.();
        if (plugin.manifest.enabled) {
          this.#state.set(plugin.manifest.id, { state: "stopped" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[p05] plugin "${plugin.manifest.id}" stop failed: ${message}`);
      }
    }
  }

  list(): PluginView[] {
    const downstream = this.registry.downstreamDefinitions();
    return this.registry.plugins().map((plugin) => {
      const state = this.#state.get(plugin.manifest.id) ?? { state: "failed" as const, lastError: "state missing" };
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
    });
  }
}