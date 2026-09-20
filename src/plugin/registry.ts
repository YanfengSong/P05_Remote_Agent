import type { AgentProvider } from "../agent/provider.js";
import type { CapabilityDescriptor } from "../capability/types.js";
import type { DownstreamDefinition } from "../downstream/types.js";
import {
  PLUGIN_API_VERSION,
  type ApplicationPlugin,
  type PluginManifest
} from "./types.js";

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class PluginRegistry {
  readonly #plugins = new Map<string, ApplicationPlugin>();

  constructor(plugins: readonly ApplicationPlugin[]) {
    for (const plugin of plugins) this.register(plugin);
    this.validateDependencies();
  }

  private register(plugin: ApplicationPlugin): void {
    const { manifest } = plugin;
    if (!PLUGIN_ID.test(manifest.id)) throw new Error(`Invalid plugin id "${manifest.id}".`);
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(
        `Plugin "${manifest.id}" requires API ${manifest.apiVersion}; supported API is ${PLUGIN_API_VERSION}.`
      );
    }
    if (this.#plugins.has(manifest.id)) throw new Error(`Duplicate plugin id "${manifest.id}".`);

    const seen = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (!capability.name.startsWith(manifest.id + ".")) {
        throw new Error(
          `Plugin "${manifest.id}" capability "${capability.name}" must use the "${manifest.id}." prefix.`
        );
      }
      if (seen.has(capability.name)) {
        throw new Error(`Plugin "${manifest.id}" declares duplicate capability "${capability.name}".`);
      }
      if (
        manifest.permissions.hostEffects === "none" &&
        (capability.scope === "host" || capability.scope === "external")
      ) {
        throw new Error(
          `Plugin "${manifest.id}" declares host/external capability "${capability.name}" while hostEffects=none.`
        );
      }
      seen.add(capability.name);
    }

    this.#plugins.set(manifest.id, plugin);
  }

  private validateDependencies(): void {
    for (const plugin of this.#plugins.values()) {
      for (const dependency of plugin.manifest.dependencies ?? []) {
        if (!dependency.optional && !this.#plugins.has(dependency.id)) {
          throw new Error(
            `Plugin "${plugin.manifest.id}" requires missing plugin "${dependency.id}".`
          );
        }
      }
    }
  }

  plugins(): ApplicationPlugin[] {
    return [...this.#plugins.values()];
  }

  get(id: string): ApplicationPlugin {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new Error(`Unknown plugin "${id}".`);
    return plugin;
  }

  manifests(): PluginManifest[] {
    return this.plugins().map((plugin) => ({
      ...plugin.manifest,
      capabilities: plugin.manifest.capabilities.map((entry) => ({ ...entry })),
      dependencies: plugin.manifest.dependencies?.map((entry) => ({ ...entry }))
    }));
  }

  capabilities(): CapabilityDescriptor[] {
    return this.plugins().flatMap((plugin) =>
      plugin.manifest.capabilities.map((entry) => ({ ...entry }))
    );
  }

  agentProviders(): Array<{ pluginId: string; provider: AgentProvider }> {
    const providers: Array<{ pluginId: string; provider: AgentProvider }> = [];
    const ids = new Set<string>();

    for (const plugin of this.plugins()) {
      for (const provider of plugin.agentProviders?.() ?? []) {
        if (ids.has(provider.id)) {
          throw new Error(`Duplicate Agent Provider id "${provider.id}" from plugins.`);
        }
        ids.add(provider.id);
        providers.push({ pluginId: plugin.manifest.id, provider });
      }
    }
    return providers;
  }

  downstreamDefinitions(): DownstreamDefinition[] {
    const definitions: DownstreamDefinition[] = [];
    const ids = new Set<string>();

    for (const plugin of this.plugins()) {
      for (const definition of plugin.downstreamDefinitions?.() ?? []) {
        if (ids.has(definition.id)) {
          throw new Error(`Duplicate downstream MCP id "${definition.id}" from plugins.`);
        }
        ids.add(definition.id);
        const declaredBinding = plugin.manifest.permissions.workspace;
        const actualBinding = definition.workspaceBinding ?? "active";
        if (declaredBinding !== actualBinding) {
          throw new Error(
            `Plugin "${plugin.manifest.id}" downstream "${definition.id}" binding "${actualBinding}" ` +
            `does not match manifest permission "${declaredBinding}".`
          );
        }
        definitions.push({
          ...definition,
          pluginId: plugin.manifest.id
        });
      }
    }
    return definitions;
  }
}