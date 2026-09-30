import fs from "node:fs";
import path from "node:path";
import type { DownstreamDefinition } from "../downstream/types.js";
import type { DownstreamRegistry } from "../downstream/registry.js";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginContext } from "./types.js";

export type PluginState = "disabled" | "ready" | "running" | "failed" | "stopped";
export type PluginDesiredState = "enabled" | "disabled";

type ControllerRecord = {
  desired: PluginDesiredState;
  manualHold: boolean;
  observed: PluginState;
  revision: number;
  updatedAt: string;
};
type ControllerFile = { version: 1; plugins: Record<string, ControllerRecord> };

export type PluginView = {
  id: string;
  label: string;
  version: string;
  apiVersion: string;
  enabled: boolean;
  desired: PluginDesiredState;
  manualHold: boolean;
  controllerRevision: number;
  state: PluginState;
  observed: PluginState;
  activeForWorkspace: boolean;
  capabilityNames: string[];
  downstreamIds: string[];
  lastError?: string;
};

export class PluginRuntime {
  readonly #state = new Map<string, { state: PluginState; lastError?: string }>();
  readonly #controller = new Map<string, ControllerRecord>();

  constructor(
    readonly registry: PluginRegistry,
    readonly workspaceManager: WorkspaceManager,
    readonly persistencePath?: string
  ) {
    const persisted = this.loadController();
    for (const plugin of registry.plugins()) {
      const desired: PluginDesiredState = plugin.manifest.enabled ? "enabled" : "disabled";
      const old = persisted.plugins[plugin.manifest.id];
      const manualHold = desired === "enabled" && old?.desired === "enabled" ? old.manualHold : false;
      const observed: PluginState = desired === "disabled" ? "disabled" : manualHold ? "stopped" : "ready";
      const record: ControllerRecord = {
        desired, manualHold, observed,
        revision: Math.max(old?.revision ?? 0, 1),
        updatedAt: old?.updatedAt ?? new Date().toISOString()
      };
      this.#controller.set(plugin.manifest.id, record);
      this.#state.set(plugin.manifest.id, { state: observed });
    }
    this.persistController();
  }

  private loadController(): ControllerFile {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return { version: 1, plugins: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as Partial<ControllerFile>;
      if (parsed.version !== 1 || !parsed.plugins || typeof parsed.plugins !== "object" || Array.isArray(parsed.plugins)) throw new Error("invalid");
      const plugins: Record<string, ControllerRecord> = {};
      for (const [id, value] of Object.entries(parsed.plugins)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const item = value as Partial<ControllerRecord>;
        if ((item.desired !== "enabled" && item.desired !== "disabled") || typeof item.manualHold !== "boolean" ||
            !["disabled", "ready", "running", "failed", "stopped"].includes(String(item.observed)) ||
            !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) continue;
        plugins[id] = {
          desired: item.desired,
          manualHold: item.manualHold,
          observed: item.observed as PluginState,
          revision: Number(item.revision),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString()
        };
      }
      return { version: 1, plugins };
    } catch {
      throw new Error("Persistent plugin controller state must be valid version 1 JSON.");
    }
  }

  private persistController(): void {
    if (!this.persistencePath) return;
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
    const payload: ControllerFile = { version: 1, plugins: Object.fromEntries([...this.#controller.entries()].map(([id, value]) => [id, { ...value }])) };
    const temp = this.persistencePath + ".tmp-" + process.pid;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.rmSync(this.persistencePath, { force: true });
    fs.renameSync(temp, this.persistencePath);
  }

  private setController(pluginId: string, patch: Partial<Pick<ControllerRecord, "manualHold" | "observed">>, bump = true): ControllerRecord {
    const current = this.#controller.get(pluginId);
    if (!current) throw new Error(`Plugin "${pluginId}" controller state is missing.`);
    const next: ControllerRecord = {
      ...current,
      ...patch,
      revision: bump ? current.revision + 1 : current.revision,
      updatedAt: new Date().toISOString()
    };
    this.#controller.set(pluginId, next);
    this.persistController();
    return next;
  }

  isAllowedForCurrentWorkspace(pluginId: string): boolean {
    const plugin = this.registry.get(pluginId);
    const controller = this.#controller.get(pluginId);
    if (!plugin.manifest.enabled || controller?.desired !== "enabled" || controller.manualHold) return false;
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
    const controller = this.#controller.get(pluginId)!;
    if (!plugin.manifest.enabled || controller.desired !== "enabled") {
      throw new Error(`Plugin "${pluginId}" is disabled by configuration.`);
    }

    if (this.#state.get(pluginId)?.state === "running" && !controller.manualHold) {
      return this.view(pluginId);
    }

    try {
      await plugin.start?.();
      this.#state.set(pluginId, { state: "running" });
      this.setController(pluginId, { manualHold: false, observed: "running" });
      return this.view(pluginId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.set(pluginId, { state: "failed", lastError: "start failed" });
      this.setController(pluginId, { observed: "failed" });
      throw new Error(`Plugin "${pluginId}" failed to start: ${message}`);
    }
  }

  private async stopObserved(
    pluginId: string,
    downstreamRegistry: DownstreamRegistry | undefined,
    manualHold: boolean
  ): Promise<PluginView> {
    const plugin = this.registry.get(pluginId);
    const controller = this.#controller.get(pluginId)!;
    if (!plugin.manifest.enabled || controller.desired !== "enabled") {
      throw new Error(`Plugin "${pluginId}" is disabled by configuration.`);
    }

    if (this.#state.get(pluginId)?.state === "stopped") {
      if (controller.manualHold !== manualHold) this.setController(pluginId, { manualHold, observed: "stopped" });
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
      this.setController(pluginId, { manualHold, observed: "stopped" });
      return this.view(pluginId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#state.set(pluginId, { state: "failed", lastError: "stop failed" });
      this.setController(pluginId, { observed: "failed" });
      throw new Error(`Plugin "${pluginId}" failed to stop: ${message}`);
    }
  }

  async stop(
    pluginId: string,
    downstreamRegistry?: DownstreamRegistry
  ): Promise<PluginView> {
    return this.stopObserved(pluginId, downstreamRegistry, true);
  }

  async restart(
    pluginId: string,
    downstreamRegistry?: DownstreamRegistry
  ): Promise<PluginView> {
    await this.stopObserved(pluginId, downstreamRegistry, false);
    return this.start(pluginId);
  }

  async startAll(): Promise<void> {
    for (const plugin of this.registry.plugins()) {
      const controller = this.#controller.get(plugin.manifest.id)!;
      if (!plugin.manifest.enabled || controller.desired !== "enabled") continue;
      if (controller.manualHold) {
        this.#state.set(plugin.manifest.id, { state: "stopped" });
        if (controller.observed !== "stopped") this.setController(plugin.manifest.id, { observed: "stopped" });
        continue;
      }
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
      const controller = this.#controller.get(plugin.manifest.id)!;
      if (controller.manualHold && this.#state.get(plugin.manifest.id)?.state === "stopped") continue;
      try {
        await this.stopObserved(plugin.manifest.id, undefined, false);
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
    const controller = this.#controller.get(pluginId) ?? { desired: "disabled" as const, manualHold: false, observed: "failed" as const, revision: 0, updatedAt: new Date(0).toISOString() };
    return {
      id: plugin.manifest.id,
      label: plugin.manifest.label,
      version: plugin.manifest.version,
      apiVersion: plugin.manifest.apiVersion,
      enabled: plugin.manifest.enabled,
      desired: controller.desired,
      manualHold: controller.manualHold,
      controllerRevision: controller.revision,
      state: state.state,
      observed: state.state,
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