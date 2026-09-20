import type { DownstreamDefinition } from "../downstream/types.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PluginRegistry } from "./registry.js";

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
  agentProviderIds: string[];
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

  isAllowedForWorkspace(pluginId: string, workspaceId: string): boolean {
    const plugin = this.registry.get(pluginId);
    if (!plugin.manifest.enabled) return false;
    const state = this.#state.get(pluginId)?.state;
    if (state === "failed" || state === "disabled" || state === "stopped") return false;
    return this.workspaceManager.pluginAllowed(
      pluginId,
      this.workspaceManager.get(workspaceId)
    );
  }

  isAllowedForCurrentWorkspace(pluginId: string): boolean {
    return this.isAllowedForWorkspace(
      pluginId,
      this.workspaceManager.current().id
    );
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

  registerTools(exposer: Exposer): void {
    for (const plugin of this.registry.plugins()) {
      if (!plugin.manifest.enabled || !plugin.registerTools) continue;

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

      plugin.registerTools(guardedExposer, { workspaceManager: this.workspaceManager });
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
        agentProviderIds: this.registry.agentProviders()
          .filter((entry) => entry.pluginId === plugin.manifest.id)
          .map((entry) => entry.provider.id),
        ...(state.lastError ? { lastError: state.lastError } : {})
      };
    });
  }
}