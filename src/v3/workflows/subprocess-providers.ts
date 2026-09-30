import { fork, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { copy, digest } from "./registry.js";
import {
  WorkflowError,
  type AgentPolicy,
  type AgentProvider,
  type ControlledExecutor,
  type ExecutionRequest,
  type ExecutionSnapshot,
  type Json,
  type ProviderUsage,
  type StateBackend,
  type WorkflowContext
} from "./types.js";

const terminalStates = new Set<ExecutionSnapshot["state"]>(["SUCCEEDED", "FAILED", "DENIED", "EXPIRED", "CANCELLED", "UNKNOWN"]);
type DurableRecord = { context: WorkflowContext; intentDigest: string; request: ExecutionRequest; snapshot: ExecutionSnapshot };
type WireMessage = Record<string, unknown>;
type Active = {
  executionId: string;
  namespace: string;
  request: ExecutionRequest;
  child: ChildProcess;
  send(value: Json): void;
  usage: ProviderUsage;
  finalized: boolean;
  cancelled: boolean;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  currentTool?: { executionId: string };
};
type Transport = { child: ChildProcess; send(value: Json): void };

export type AgentProviderCommonOptions = {
  providerId: string;
  revision: string;
  state: StateBackend;
  toolExecutor: ControlledExecutor;
  maxMessageBytes?: number;
};
export type CliAgentProviderOptions = AgentProviderCommonOptions & { command: string; args?: string[] };
export type ProtocolAgentProviderOptions = AgentProviderCommonOptions & { modulePath: string; args?: string[] };

function providerEnv(): NodeJS.ProcessEnv {
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === "string"));
}
function object(value: unknown): WireMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("AGENT_PROTOCOL_INVALID", "Agent message must be an object");
  return value as WireMessage;
}
function text(value: unknown, max = 160): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new WorkflowError("AGENT_PROTOCOL_INVALID", "Agent message text is invalid");
  return value;
}
function policy(request: ExecutionRequest): AgentPolicy {
  const value = request.agentPolicy;
  if (!value || !Array.isArray(value.allowedTools) || !Number.isSafeInteger(value.maxInternalToolCalls) || value.maxInternalToolCalls < 0 ||
      !Number.isSafeInteger(value.maxIterations) || value.maxIterations < 0 || !Number.isFinite(value.deadline)) {
    throw new WorkflowError("PROVIDER_POLICY_REQUIRED", "Agent provider requires a platform-generated policy");
  }
  return value;
}

abstract class SubprocessAgentProvider implements AgentProvider {
  readonly providerId: string;
  readonly revision: string;
  private readonly active = new Map<string, Active>();
  private readonly messageLimit: number;
  private closed = false;

  protected constructor(protected readonly options: AgentProviderCommonOptions) {
    this.providerId = options.providerId;
    this.revision = options.revision;
    this.messageLimit = options.maxMessageBytes ?? 256 * 1024;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(this.providerId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(this.revision)) {
      throw new WorkflowError("INVALID_PROVIDER_IDENTITY", "Provider identity is invalid");
    }
    if (!Number.isSafeInteger(this.messageLimit) || this.messageLimit < 1024 || this.messageLimit > 1024 * 1024) {
      throw new WorkflowError("INVALID_PROVIDER_LIMIT", "Provider message limit is invalid");
    }
  }

  protected abstract launch(request: ExecutionRequest, receive: (message: unknown) => void, exited: () => void): Transport;

  private namespace(c: WorkflowContext): string {
    return "agent:" + digest({ provider: this.providerId, revision: this.revision, principal: c.principal, slotId: c.slotId });
  }
  private id(key: string): string { return "agent-" + digest(key); }

  async submit(request: ExecutionRequest): Promise<ExecutionSnapshot> {
    if (this.closed || request.capability !== this.providerId || request.capabilityVersion !== this.revision) {
      throw new WorkflowError("PROVIDER_UNAVAILABLE", "Pinned subprocess provider unavailable");
    }
    if (request.context.securityMode !== "trusted-host") throw new WorkflowError("PROVIDER_SECURITY_MODE_UNSUPPORTED", "Subprocess Agent provider is trusted-host only");
    policy(request);
    const safeRequest = copy(request);
    const namespace = this.namespace(request.context), executionId = this.id(request.idempotencyKey), intentDigest = digest(safeRequest);
    const existing = await this.options.state.read(namespace, executionId);
    if (existing) {
      const record = existing.value as unknown as DurableRecord;
      if (record.intentDigest !== intentDigest) throw new WorkflowError("IDEMPOTENCY_CONFLICT", "Provider key intent changed");
      return this.status(request.context, executionId);
    }
    const record: DurableRecord = {
      context: copy(request.context),
      intentDigest,
      request: safeRequest,
      snapshot: { executionId, state: "RUNNING", usage: { internalToolCalls: 0, iterations: 0 } }
    };
    if (!await this.options.state.compareAndSet(namespace, executionId, null, copy(record) as unknown as Json)) return this.submit(request);
    this.start(namespace, executionId, safeRequest);
    return copy(record.snapshot);
  }

  private start(namespace: string, executionId: string, request: ExecutionRequest): void {
    let active!: Active;
    try {
      const transport = this.launch(request, message => this.enqueue(active, message), () => { void this.exited(active); });
      active = {
        executionId, namespace, request, child: transport.child, send: transport.send,
        usage: { internalToolCalls: 0, iterations: 0 }, finalized: false, cancelled: false, queue: Promise.resolve()
      };
      this.active.set(executionId, active);
      const remaining = policy(request).deadline - Date.now();
      if (remaining <= 0) { void this.budget(active, "timeout"); return; }
      active.timer = setTimeout(() => { void this.budget(active, "timeout"); }, Math.min(remaining, 0x7fffffff));
      active.send(copy({
        type: "start",
        input: request.input,
        session: {
          allowedTools: policy(request).allowedTools,
          maxInternalToolCalls: policy(request).maxInternalToolCalls,
          maxIterations: policy(request).maxIterations,
          deadline: policy(request).deadline,
          workspaceId: request.context.workspaceId,
          securityMode: request.context.securityMode
        }
      }) as Json);
    } catch {
      if (active) { active.finalized = true; if (active.timer) clearTimeout(active.timer); this.active.delete(executionId); try { active.child.kill(); } catch { /* failed launch */ } }
      void this.complete(namespace, executionId, {
        executionId, state: "FAILED", safeRetry: false,
        result: { code: "AGENT_PROCESS_START_FAILED" }, usage: { internalToolCalls: 0, iterations: 0 }
      });
    }
  }

  private enqueue(active: Active, message: unknown): void {
    if (!active || active.finalized) return;
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(message)); } catch { bytes = this.messageLimit + 1; }
    if (bytes > this.messageLimit) { void this.fail(active, "AGENT_MESSAGE_LIMIT"); return; }
    active.queue = active.queue.then(() => this.message(active, message)).catch(() => this.fail(active, "AGENT_PROTOCOL_INVALID"));
  }

  private async message(active: Active, raw: unknown): Promise<void> {
    if (active.finalized) return;
    const value = object(raw), type = text(value.type, 32);
    if (type === "iteration") {
      const p = policy(active.request);
      if (active.usage.iterations >= p.maxIterations) { await this.budget(active, "iterations"); return; }
      active.usage.iterations++;
      return;
    }
    if (type === "tool_call") {
      const id = text(value.id, 96), capability = text(value.capability, 96), capabilityVersion = text(value.capabilityVersion, 96);
      const input = copy(value.input as Json);
      const p = policy(active.request);
      if (!p.allowedTools.some(item => item.capability === capability && item.capabilityVersion === capabilityVersion)) {
        await this.fail(active, "AGENT_TOOL_FORBIDDEN");
        return;
      }
      if (active.usage.internalToolCalls >= p.maxInternalToolCalls) { await this.budget(active, "tool-calls"); return; }
      active.usage.internalToolCalls++;
      const result = await this.tool(active, capability, capabilityVersion, input);
      if (active.finalized) return;
      active.send(copy({ type: "tool_result", id, ...result }) as Json);
      return;
    }
    if (type === "result") {
      const result = copy(value.result as Json);
      await this.finish(active, { executionId: active.executionId, state: "SUCCEEDED", result, usage: { ...active.usage } });
      return;
    }
    if (type === "failed") {
      const code = text(value.code, 120);
      await this.finish(active, { executionId: active.executionId, state: "FAILED", safeRetry: false, result: { code }, usage: { ...active.usage } });
      return;
    }
    throw new WorkflowError("AGENT_PROTOCOL_INVALID", "Unknown Agent message");
  }

  private async tool(active: Active, capability: string, capabilityVersion: string, input: Json): Promise<{ ok: boolean; state: string; result?: Json | null }> {
    const key = active.request.idempotencyKey + ":tool:" + active.usage.internalToolCalls;
    let snapshot = await this.options.toolExecutor.submit({
      context: copy(active.request.context), capability, capabilityVersion, input: copy(input), idempotencyKey: key
    });
    active.currentTool = { executionId: snapshot.executionId };
    while (!terminalStates.has(snapshot.state)) {
      if (active.cancelled) {
        try { snapshot = await this.options.toolExecutor.cancel(active.request.context, snapshot.executionId); } catch { return { ok: false, state: "UNKNOWN" }; }
      } else {
        if (Date.now() >= policy(active.request).deadline) { await this.budget(active, "timeout"); return { ok: false, state: "EXPIRED" }; }
        await sleep(10);
        snapshot = await this.options.toolExecutor.status(active.request.context, snapshot.executionId);
      }
    }
    active.currentTool = undefined;
    if (snapshot.state === "UNKNOWN") {
      await this.fail(active, "AGENT_TOOL_UNCONFIRMED");
      return { ok: false, state: "UNKNOWN" };
    }
    return snapshot.state === "SUCCEEDED"
      ? { ok: true, state: snapshot.state, result: copy(snapshot.result ?? null) }
      : { ok: false, state: snapshot.state, ...(snapshot.result === undefined ? {} : { result: copy(snapshot.result) }) };
  }

  private async budget(active: Active, dimension: string): Promise<void> {
    if (active.finalized) return;
    await this.stopTool(active);
    await this.finish(active, {
      executionId: active.executionId, state: "EXPIRED", budgetExhausted: true,
      result: { code: "AGENT_BUDGET_EXHAUSTED", dimension }, usage: { ...active.usage }
    });
  }

  private async fail(active: Active, code: string): Promise<void> {
    if (active.finalized) return;
    await this.stopTool(active);
    await this.finish(active, {
      executionId: active.executionId, state: "FAILED", safeRetry: false,
      result: { code }, usage: { ...active.usage }
    });
  }

  private async stopTool(active: Active): Promise<void> {
    if (!active.currentTool) return;
    try { await this.options.toolExecutor.cancel(active.request.context, active.currentTool.executionId); } catch { /* final provider result stays fail-closed */ }
    active.currentTool = undefined;
  }

  private async finish(active: Active, snapshot: ExecutionSnapshot): Promise<void> {
    if (active.finalized) return;
    active.finalized = true;
    if (active.timer) clearTimeout(active.timer);
    this.active.delete(active.executionId);
    try { active.child.kill(); } catch { /* already exited */ }
    await this.complete(active.namespace, active.executionId, snapshot);
  }

  private async complete(namespace: string, executionId: string, snapshot: ExecutionSnapshot): Promise<void> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const stored = await this.options.state.read(namespace, executionId);
      if (!stored) return;
      const record = stored.value as unknown as DurableRecord;
      if (terminalStates.has(record.snapshot.state)) return;
      record.snapshot = copy(snapshot);
      if (await this.options.state.compareAndSet(namespace, executionId, stored.version, copy(record) as unknown as Json)) return;
    }
    throw new WorkflowError("STATE_CONFLICT", "Provider state changed repeatedly");
  }

  private async exited(active: Active): Promise<void> {
    if (!active || active.finalized) return;
    await active.queue.catch(() => undefined);
    if (active.finalized) return;
    if (active.cancelled) {
      await this.finish(active, { executionId: active.executionId, state: "CANCELLED", usage: { ...active.usage } });
    } else {
      await this.fail(active, "AGENT_PROCESS_EXITED");
    }
  }

  async status(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    const namespace = this.namespace(context), stored = await this.options.state.read(namespace, executionId);
    if (!stored) throw new WorkflowError("NOT_FOUND", "Provider invocation not found");
    const record = stored.value as unknown as DurableRecord;
    if (digest(record.context) !== digest(context)) throw new WorkflowError("NOT_FOUND", "Provider invocation context mismatch");
    if (["RUNNING", "CANCEL_REQUESTED"].includes(record.snapshot.state) && !this.active.has(executionId)) {
      record.snapshot = { executionId, state: "UNKNOWN", usage: record.snapshot.usage ?? { internalToolCalls: 0, iterations: 0 } };
      if (!await this.options.state.compareAndSet(namespace, executionId, stored.version, copy(record) as unknown as Json)) return this.status(context, executionId);
    }
    return copy(record.snapshot);
  }

  async find(context: WorkflowContext, key: string): Promise<ExecutionSnapshot | undefined> {
    const executionId = this.id(key);
    return (await this.options.state.read(this.namespace(context), executionId)) ? this.status(context, executionId) : undefined;
  }

  async cancel(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    const namespace = this.namespace(context);
    const stored = await this.options.state.read(namespace, executionId);
    if (!stored) throw new WorkflowError("NOT_FOUND", "Provider invocation not found");
    const record = stored.value as unknown as DurableRecord;
    if (digest(record.context) !== digest(context)) throw new WorkflowError("NOT_FOUND", "Provider invocation context mismatch");
    if (terminalStates.has(record.snapshot.state)) return copy(record.snapshot);
    record.snapshot = { ...record.snapshot, state: "CANCEL_REQUESTED" };
    if (!await this.options.state.compareAndSet(namespace, executionId, stored.version, copy(record) as unknown as Json)) return this.cancel(context, executionId);
    const active = this.active.get(executionId);
    if (active) {
      active.cancelled = true;
      await this.stopTool(active);
      try { active.child.kill(); } catch { /* exit observer will reconcile */ }
    }
    return copy(record.snapshot);
  }

  close(): void {
    this.closed = true;
    for (const active of this.active.values()) {
      active.finalized = true;
      if (active.timer) clearTimeout(active.timer);
      try { active.child.kill(); } catch { /* best effort */ }
    }
    this.active.clear();
  }
}

export class CliAgentProvider extends SubprocessAgentProvider {
  private readonly command: string;
  private readonly args: string[];
  constructor(options: CliAgentProviderOptions) {
    super(options);
    if (!path.isAbsolute(options.command)) throw new WorkflowError("PROVIDER_COMMAND_INVALID", "CLI provider command must be absolute");
    this.command = options.command;
    this.args = [...options.args ?? []];
  }
  protected launch(request: ExecutionRequest, receive: (message: unknown) => void, exited: () => void): Transport {
    const child = spawn(this.command, this.args, {
      cwd: request.context.workspaceRoot, env: providerEnv(), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"]
    });
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > (this.options.maxMessageBytes ?? 256 * 1024) * 2) { receive({ type: "failed", code: "AGENT_MESSAGE_LIMIT" }); return; }
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { receive(JSON.parse(line)); } catch { receive({ type: "failed", code: "AGENT_PROTOCOL_INVALID" }); }
      }
    });
    child.once("error", exited);
    child.once("exit", exited);
    return {
      child,
      send(value: Json) {
        if (!child.stdin?.writable) throw new WorkflowError("PROVIDER_TRANSPORT_CLOSED", "CLI provider stdin closed");
        child.stdin.write(JSON.stringify(value) + "\n");
      }
    };
  }
}

export class ProtocolAgentProvider extends SubprocessAgentProvider {
  private readonly modulePath: string;
  private readonly args: string[];
  constructor(options: ProtocolAgentProviderOptions) {
    super(options);
    if (!path.isAbsolute(options.modulePath)) throw new WorkflowError("PROVIDER_MODULE_INVALID", "Protocol provider module must be absolute");
    this.modulePath = options.modulePath;
    this.args = [...options.args ?? []];
  }
  protected launch(request: ExecutionRequest, receive: (message: unknown) => void, exited: () => void): Transport {
    const child = fork(this.modulePath, this.args, {
      cwd: request.context.workspaceRoot, env: providerEnv(), execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    child.on("message", receive);
    child.once("error", exited);
    child.once("exit", exited);
    return {
      child,
      send(value: Json) {
        if (!child.connected) throw new WorkflowError("PROVIDER_TRANSPORT_CLOSED", "Protocol provider IPC closed");
        child.send(value as never);
      }
    };
  }
}
