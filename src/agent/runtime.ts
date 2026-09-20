import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentProviderHandle } from "./provider.js";
import type { AgentOutputView, AgentProviderView, AgentSessionView } from "./types.js";
import type { ToolProfile } from "../capability/types.js";
import type { WorkspaceIsolationManager } from "../isolation/manager.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { PluginRuntime } from "../plugin/runtime.js";
import type { ProcessRuntime } from "../process/runtime.js";
import { createExecutionContext } from "../runtime/context.js";
import { attachExecutionCorrelation, currentExecutionId } from "../runtime/execution.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionRecord } from "../session/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";

type ProviderEntry = {
  pluginId: string;
  provider: AgentProvider;
};

type LiveAgent = ProviderEntry & {
  handle: AgentProviderHandle;
  isolationId: string;
};

function terminal(state: SessionRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

export class AgentRuntime {
  readonly #sessions: SessionManager;
  readonly #processRuntime: ProcessRuntime;
  readonly #isolation: WorkspaceIsolationManager;
  readonly #pluginRegistry: PluginRegistry;
  readonly #pluginRuntime: PluginRuntime;
  readonly #workspaceManager: WorkspaceManager;
  readonly #profile: ToolProfile;
  readonly #providers = new Map<string, ProviderEntry>();
  readonly #live = new Map<string, LiveAgent>();

  constructor(args: {
    sessions: SessionManager;
    processRuntime: ProcessRuntime;
    isolation: WorkspaceIsolationManager;
    pluginRegistry: PluginRegistry;
    pluginRuntime: PluginRuntime;
    workspaceManager: WorkspaceManager;
    profile: ToolProfile;
  }) {
    this.#sessions = args.sessions;
    this.#processRuntime = args.processRuntime;
    this.#isolation = args.isolation;
    this.#pluginRegistry = args.pluginRegistry;
    this.#pluginRuntime = args.pluginRuntime;
    this.#workspaceManager = args.workspaceManager;
    this.#profile = args.profile;

    for (const entry of this.#pluginRegistry.agentProviders()) {
      if (this.#providers.has(entry.provider.id)) {
        throw new Error('Duplicate Agent Provider id "' + entry.provider.id + '".');
      }
      this.#providers.set(entry.provider.id, entry);
    }
  }

  #provider(providerId: string): ProviderEntry {
    const entry = this.#providers.get(providerId);
    if (!entry) throw new Error('Unknown Agent Provider "' + providerId + '".');
    return entry;
  }

  #assertInteractiveAccess(id: string): SessionRecord {
    const record = this.#sessions.get(id);
    if (record.kind !== "agent") {
      throw new Error('Session "' + id + '" is not an Agent session.');
    }
    const current = this.#workspaceManager.current();
    if (record.context.workspaceId !== current.id) {
      throw new Error(
        'Agent session "' + id + '" belongs to workspace "' +
        record.context.workspaceId + '", not active workspace "' + current.id + '".'
      );
    }
    return record;
  }

  #view(record: SessionRecord): AgentSessionView {
    const providerId = typeof record.attributes.providerId === "string"
      ? record.attributes.providerId
      : "unknown";
    const taskCount = typeof record.attributes.taskCount === "number"
      ? record.attributes.taskCount
      : 0;
    const isolationId = typeof record.attributes.isolationId === "string"
      ? record.attributes.isolationId
      : undefined;
    return {
      id: record.id,
      providerId,
      workspaceId: record.context.workspaceId,
      state: record.state,
      actorId: record.context.actor.id,
      ...(isolationId ? { isolationId } : {}),
      ...(record.context.isolation ? { isolationKind: record.context.isolation.kind } : {}),
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      lastActivityAt: record.lastActivityAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      recoveryHint: record.recoveryHint,
      taskCount
    };
  }

  providers(): AgentProviderView[] {
    const workspaceId = this.#workspaceManager.current().id;
    return [...this.#providers.values()]
      .map(({ pluginId, provider }) => {
        const plugin = this.#pluginRegistry.get(pluginId);
        return {
          id: provider.id,
          label: provider.label,
          pluginId,
          enabled: plugin.manifest.enabled,
          activeForWorkspace: this.#pluginRuntime.isAllowedForWorkspace(pluginId, workspaceId),
          writeAccess: provider.writeAccess
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  sessions(): AgentSessionView[] {
    const workspaceId = this.#workspaceManager.current().id;
    return this.#sessions.list({ workspaceId, kind: "agent" })
      .map((record) => this.#view(record));
  }

  async start(providerId: string): Promise<AgentSessionView> {
    const entry = this.#provider(providerId);
    const workspace = this.#workspaceManager.current();
    if (!this.#pluginRuntime.isAllowedForWorkspace(entry.pluginId, workspace.id)) {
      throw new Error(
        'Agent Provider "' + providerId + '" is not enabled for workspace "' + workspace.id + '".'
      );
    }

    const actorId = "agent-" + randomUUID().replaceAll("-", "").slice(0, 16);
    const baseContext = createExecutionContext({
      workspace,
      actor: { type: "agent", id: actorId },
      profile: this.#profile,
      executionId: currentExecutionId()
    });

    const allocation = await this.#isolation.allocate(
      baseContext,
      entry.provider.writeAccess ? "worktree" : "workspace"
    );

    const session = this.#sessions.create({
      kind: "agent",
      driverId: "agent-provider:" + providerId,
      context: allocation.context,
      attributes: {
        providerId,
        isolationId: allocation.isolation.id,
        taskCount: 0,
        writeAccess: entry.provider.writeAccess
      }
    });
    this.#sessions.transition(session.id, "starting");
    const captured = this.#sessions.get(session.id).context;
    attachExecutionCorrelation({
      sessionId: session.id,
      actorType: captured.actor.type,
      actorId: captured.actor.id,
      taskId: captured.taskId
    });

    try {
      const handle = await entry.provider.start(captured, {
        processRuntime: this.#processRuntime
      });
      this.#live.set(session.id, {
        ...entry,
        handle,
        isolationId: allocation.isolation.id
      });
      this.#sessions.transition(session.id, "running", { recoveryHint: "inspect" });
      return this.#view(this.#sessions.get(session.id));
    } catch (error) {
      this.#sessions.transition(session.id, "failed", { recoveryHint: "inspect" });
      try {
        await this.#isolation.release(captured, allocation.isolation.id);
      } catch {
        // Preserve a non-empty/broken isolation for inspection.
      }
      throw error;
    }
  }

  async task(id: string, task: string): Promise<AgentSessionView> {
    if (!task.trim()) throw new Error("Agent task must not be blank.");
    const record = this.#assertInteractiveAccess(id);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    if (record.state !== "running") {
      throw new Error('Agent session "' + id + '" is not running.');
    }
    const live = this.#live.get(id);
    if (!live) throw new Error('Agent session "' + id + '" has no live provider handle.');

    await live.provider.task(
      live.handle,
      record.context,
      task,
      { processRuntime: this.#processRuntime }
    );
    const taskCount = typeof record.attributes.taskCount === "number"
      ? record.attributes.taskCount + 1
      : 1;
    this.#sessions.touch(id, { taskCount });
    return this.#view(this.#sessions.get(id));
  }

  async status(id: string): Promise<AgentSessionView> {
    let record = this.#assertInteractiveAccess(id);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    const live = this.#live.get(id);
    if (live && !terminal(record.state)) {
      try {
        const providerStatus = await live.provider.status(
          live.handle,
          record.context,
          { processRuntime: this.#processRuntime }
        );
        if (providerStatus.state === "completed") {
          this.#sessions.transition(id, "completed", { recoveryHint: "none" });
          this.#live.delete(id);
        } else if (providerStatus.state === "failed") {
          this.#sessions.transition(id, "failed", { recoveryHint: "inspect" });
          this.#live.delete(id);
        }
      } catch {
        this.#sessions.transition(id, "failed", { recoveryHint: "inspect" });
        this.#live.delete(id);
      }
      record = this.#sessions.get(id);
    }
    return this.#view(record);
  }

  async output(
    id: string,
    cursor = 0,
    maxChars = 65536
  ): Promise<AgentOutputView> {
    const record = this.#assertInteractiveAccess(id);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    const live = this.#live.get(id);
    if (!live) {
      return {
        agentSessionId: id,
        state: record.state,
        events: [],
        nextCursor: cursor,
        truncated: false
      };
    }
    const output = await live.provider.output(
      live.handle,
      record.context,
      cursor,
      maxChars,
      { processRuntime: this.#processRuntime }
    );
    return {
      agentSessionId: id,
      state: record.state,
      events: output.events,
      nextCursor: output.nextCursor,
      truncated: output.truncated
    };
  }

  async stop(id: string, force = false): Promise<AgentSessionView> {
    const record = this.#assertInteractiveAccess(id);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    if (terminal(record.state)) return this.#view(record);
    const live = this.#live.get(id);
    if (!live) {
      this.#sessions.transition(id, "interrupted", { recoveryHint: "inspect" });
      return this.#view(this.#sessions.get(id));
    }

    this.#sessions.transition(id, "stopping", { recoveryHint: "inspect" });
    try {
      await live.provider.stop(
        live.handle,
        record.context,
        force,
        { processRuntime: this.#processRuntime }
      );
      this.#sessions.transition(id, "completed", { recoveryHint: "none" });
    } catch {
      this.#sessions.transition(id, "failed", { recoveryHint: "inspect" });
    } finally {
      this.#live.delete(id);
    }

    try {
      await this.#isolation.release(record.context, live.isolationId);
    } catch {
      this.#sessions.touch(id, { isolationPending: true });
    }
    return this.#view(this.#sessions.get(id));
  }

  async interruptAll(): Promise<void> {
    for (const [id, live] of [...this.#live.entries()]) {
      let record: SessionRecord;
      try { record = this.#sessions.get(id); } catch { continue; }
      try {
        await live.provider.stop(
          live.handle,
          record.context,
          true,
          { processRuntime: this.#processRuntime }
        );
      } catch {
        // Best effort shutdown.
      }
      if (!terminal(record.state)) {
        this.#sessions.transition(id, "interrupted", { recoveryHint: "inspect" });
      }
      this.#live.delete(id);
    }
  }
}
