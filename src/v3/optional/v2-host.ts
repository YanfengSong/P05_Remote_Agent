import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const V2_READONLY_CAPABILITIES = Object.freeze({
  ping: "ping", workspace_current: "workspace_current", fs_read: "fs_read", fs_list: "fs_list",
  git_status: "git_status", git_diff: "git_diff"
});
const KNOWN_TOOLS = new Set([
  ...Object.values(V2_READONLY_CAPABILITIES), "device_info", "workspace_list", "reference_list", "reference_read",
  "reference_list_directory", "activity_recent", "recovery_status", "plugin_list", "git_diff_stat",
  "fs_write", "apply_patch", "git_add", "git_commit", "git_branch", "git_push", "command_run",
  "runtime_restart", "shell_run", "mcp_list_tools", "mcp_status", "mcp_call_tool",
  "matlab.call_tool", "matlab.skill_list", "matlab.skill_read"
]);
const FIXED_ENV = new Set([
  "P05_STATE_DIR", "P05_RUNTIME_SLOT", "P05_TOOL_PROFILE", "P05_WORKSPACES_JSON", "P05_ACTIVE_WORKSPACE_ID",
  "REMOTE_AGENT_ALLOWED_ROOTS", "REMOTE_AGENT_DEFAULT_CWD", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"
]);
const BOUND_WORKSPACE_ID = "v3-bound";

export type OptionalHostOptions = {
  nodeExecutable: string;
  entrypoint: string;
  workspaceRoot: string;
  slot: "A" | "B";
  /** Core's state parent. The bridge creates a separate generation-specific child directory. */
  stateDir: string;
  profile: "readonly" | "developer" | "full";
  capabilities?: Readonly<Record<string, string>>;
  environmentAllowlist?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export type OptionalHostHealth = {
  state: "stopped" | "starting" | "ready" | "degraded";
  generation: string;
  profile: OptionalHostOptions["profile"];
  capabilities: string[];
  pendingCalls: number;
  lastError?: string;
};
export type OptionalTool = { capability: string; tool: string; inputSchema: unknown };
export type OptionalCallView = {
  callId: string;
  generation: string;
  state: "pending" | "completed" | "unknown";
  result?: Record<string, unknown>;
  approval?: { state: "approval_required" | "approval_denied"; approvalId?: string };
  error?: string;
};

function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 600_000) throw new Error("Invalid Optional Host timeout.");
  return result;
}

export function createOptionalEnvironment(
  options: Pick<OptionalHostOptions, "workspaceRoot" | "slot" | "profile" | "environmentAllowlist" | "environment"> & { stateDir: string },
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const environment: Record<string, string> = {};
  const find = (name: string) => Object.entries(source).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = find(key);
    if (value !== undefined && !value.startsWith("()")) environment[key] = value;
  }
  const allowlist = new Set((options.environmentAllowlist ?? []).map((key) => key.toUpperCase()));
  for (const key of allowlist) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || FIXED_ENV.has(key) || key.startsWith("P05_V3_") || key.startsWith("DYLD_")) {
      throw new Error("Optional Host environment allowlist contains a protected key.");
    }
    const value = find(key);
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (!allowlist.has(key.toUpperCase())) throw new Error("Optional Host environment override is not allowlisted.");
    environment[key.toUpperCase()] = value;
  }
  return {
    ...environment,
    REMOTE_AGENT_ALLOWED_ROOTS: options.workspaceRoot,
    REMOTE_AGENT_DEFAULT_CWD: options.workspaceRoot,
    P05_RUNTIME_SLOT: options.slot,
    P05_STATE_DIR: options.stateDir,
    P05_TOOL_PROFILE: options.profile,
    P05_WORKSPACES_JSON: JSON.stringify([{ id: BOUND_WORKSPACE_ID, root: options.workspaceRoot, kind: "platform-source" }]),
    P05_ACTIVE_WORKSPACE_ID: BOUND_WORKSPACE_ID
  };
}

function approvalOf(result: Record<string, unknown>): OptionalCallView["approval"] {
  if (result.isError !== true || !Array.isArray(result.content)) return undefined;
  const text = result.content.filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => String(part.text ?? "")).join("\n");
  const state = text.includes("PERMISSION_CONFIRM_REQUIRED") ? "approval_required"
    : text.includes("PERMISSION_CONFIRM_DENIED") ? "approval_denied" : undefined;
  if (!state) return undefined;
  const id = text.match(/^approvalId:\s*([a-f0-9-]{36})\s*$/im)?.[1];
  return { state, ...(id ? { approvalId: id } : {}) };
}

/** Process/failure isolation for the trusted V2 compatibility runtime, not an OS sandbox. */
export class V2OptionalHost {
  readonly #options: OptionalHostOptions;
  readonly #mapping: Readonly<Record<string, string>>;
  #state: OptionalHostHealth["state"] = "stopped";
  #generation = "";
  #lastError?: string;
  #client?: Client;
  #tools: OptionalTool[] = [];
  #starting?: Promise<OptionalHostHealth>;
  #lifecycleVersion = 0;
  #calls = new Map<string, { view: OptionalCallView; completion: Promise<void> }>();

  constructor(options: OptionalHostOptions) {
    for (const value of [options.nodeExecutable, options.entrypoint, options.workspaceRoot, options.stateDir]) {
      if (!path.isAbsolute(value)) throw new Error("Optional Host paths must be explicit absolute paths.");
    }
    if (!["A", "B"].includes(options.slot) || !["readonly", "developer", "full"].includes(options.profile)) {
      throw new Error("Invalid Optional Host slot or profile.");
    }
    this.#options = {
      ...options,
      workspaceRoot: fs.realpathSync(options.workspaceRoot),
      environmentAllowlist: [...(options.environmentAllowlist ?? [])],
      environment: { ...options.environment }
    };
    this.#mapping = Object.freeze({ ...(options.capabilities ?? V2_READONLY_CAPABILITIES) });
    for (const [capability, tool] of Object.entries(this.#mapping)) {
      if (!/^[a-z][a-z0-9._-]{0,159}$/.test(capability) || !KNOWN_TOOLS.has(tool)) {
        throw new Error("Optional Host capability mapping is not explicitly supported.");
      }
    }
    timeout(options.startTimeoutMs, 15_000);
    timeout(options.requestTimeoutMs, 600_000);
  }

  health(): OptionalHostHealth {
    return {
      state: this.#state, generation: this.#generation, profile: this.#options.profile,
      capabilities: this.#tools.map((tool) => tool.capability),
      pendingCalls: [...this.#calls.values()].filter((call) => call.view.state === "pending").length,
      ...(this.#lastError ? { lastError: this.#lastError } : {})
    };
  }

  start(): Promise<OptionalHostHealth> {
    if (this.#state === "ready") return Promise.resolve(this.health());
    if (this.#starting) return this.#starting;
    this.#starting = this.#start(++this.#lifecycleVersion).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(lifecycleVersion: number): Promise<OptionalHostHealth> {
    await this.#dispose();
    if (this.#lifecycleVersion !== lifecycleVersion) return this.health();
    this.#generation = randomUUID();
    const generation = this.#generation;
    this.#state = "starting";
    this.#lastError = undefined;
    const client = new Client({ name: "p05-v3-optional-bridge", version: "0.1.0" });
    this.#client = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stateDir = path.join(this.#options.stateDir, "optional-v2", this.#options.slot, generation);
      fs.mkdirSync(stateDir, { recursive: true });
      const transport = new StdioClientTransport({
        command: this.#options.nodeExecutable, args: [this.#options.entrypoint],
        cwd: this.#options.workspaceRoot,
        env: createOptionalEnvironment({ ...this.#options, stateDir }),
        stderr: "pipe", maxBufferSize: 2 * 1024 * 1024
      });
      // Drain bounded diagnostic data without retaining or forwarding secrets.
      let stderrBytes = 0;
      transport.stderr?.on("data", (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes >= 64 * 1024 && transport.stderr instanceof Readable) transport.stderr.pause();
      });
      client.onclose = () => this.#lost(client, "HOST_DISCONNECTED");
      client.onerror = () => this.#lost(client, "HOST_PROTOCOL_ERROR");
      const initialize = (async () => {
        await client.connect(transport);
        const listed = await client.listTools({}, { timeout: timeout(this.#options.startTimeoutMs, 15_000) });
        if (this.#client !== client || this.#generation !== generation) throw new Error("Obsolete host generation.");
        this.#tools = Object.entries(this.#mapping).flatMap(([capability, tool]) => {
          const found = listed.tools.find((candidate) => candidate.name === tool);
          return found ? [{ capability, tool, inputSchema: found.inputSchema }] : [];
        });
        if (!listed.tools.some((tool) => tool.name === "workspace_current")) throw new Error("Workspace identity is unavailable.");
        await this.#checkWorkspace(client);
      })();
      await Promise.race([initialize, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host startup timeout.")), timeout(this.#options.startTimeoutMs, 15_000));
      })]);
      if (this.#client === client && this.#generation === generation && this.#state === "starting") this.#state = "ready";
    } catch {
      if (this.#client === client) {
        this.#state = "degraded";
        this.#lastError = "HOST_START_FAILED";
        this.#tools = [];
        this.#client = undefined;
      }
      await client.close().catch(() => undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.health();
  }

  #lost(client: Client, reason: string): void {
    if (this.#client !== client) return;
    this.#state = "degraded";
    this.#lastError = reason;
    this.#tools = [];
    for (const call of this.#calls.values()) {
      if (call.view.state === "pending") call.view = { ...call.view, state: "unknown", error: reason };
    }
  }

  async #checkWorkspace(client: Client): Promise<void> {
    const result = await client.callTool({ name: "workspace_current", arguments: {} }, { timeout: 5000 });
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError || structured?.id !== BOUND_WORKSPACE_ID) throw new Error("WORKSPACE_BINDING_CHANGED");
  }

  async listTools(): Promise<OptionalTool[]> {
    if (this.#state !== "ready") return [];
    return structuredClone(this.#tools);
  }

  async call(capability: string, input: Record<string, unknown>, options: { waitMs?: number } = {}): Promise<OptionalCallView> {
    if (this.#state !== "ready" || !this.#client) throw new Error("OPTIONAL_HOST_UNAVAILABLE");
    const tool = this.#tools.find((entry) => entry.capability === capability);
    if (!tool) throw new Error("OPTIONAL_CAPABILITY_UNAVAILABLE");
    if (this.health().pendingCalls >= 16) throw new Error("OPTIONAL_HOST_BUSY");
    const waitMs = options.waitMs ?? 1000;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("Invalid Optional Host wait.");
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 256 * 1024) throw new Error("OPTIONAL_INPUT_TOO_LARGE");
    const frozenInput = JSON.parse(payload) as Record<string, unknown>;
    if (!frozenInput || typeof frozenInput !== "object" || Array.isArray(frozenInput)) throw new Error("OPTIONAL_INPUT_INVALID");
    while (this.#calls.size >= 200) {
      const terminal = [...this.#calls].find(([, call]) => call.view.state !== "pending");
      if (!terminal) throw new Error("OPTIONAL_HOST_BUSY");
      this.#calls.delete(terminal[0]);
    }
    const client = this.#client;
    const view: OptionalCallView = { callId: randomUUID(), generation: this.#generation, state: "pending" };
    const record = { view, completion: Promise.resolve() };
    this.#calls.set(view.callId, record);
    record.completion = (async () => {
      try {
        await this.#checkWorkspace(client);
        if (this.#client !== client || this.#state !== "ready") throw new Error("OPTIONAL_HOST_UNAVAILABLE");
        const result = await client.callTool({ name: tool.tool, arguments: frozenInput }, {
          timeout: timeout(this.#options.requestTimeoutMs, 600_000),
          maxTotalTimeout: timeout(this.#options.requestTimeoutMs, 600_000)
        }) as Record<string, unknown>;
        // A transport error/closure leaves results unknown, never silently replayed.
        if (record.view.state === "pending") record.view = { ...view, state: "completed", result, ...(approvalOf(result) ? { approval: approvalOf(result) } : {}) };
      } catch (error) {
        const reason = error instanceof Error && error.message === "WORKSPACE_BINDING_CHANGED"
          ? "WORKSPACE_BINDING_CHANGED" : "V2_RESULT_UNKNOWN";
        if (reason === "WORKSPACE_BINDING_CHANGED") this.#lost(client, reason);
        if (record.view.state === "pending") record.view = { ...view, state: "unknown", error: reason };
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (waitMs > 0) {
      try { await Promise.race([record.completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    return structuredClone(record.view);
  }

  callStatus(callId: string): OptionalCallView | undefined {
    const record = this.#calls.get(callId);
    return record ? structuredClone(record.view) : undefined;
  }

  async close(): Promise<void> {
    this.#lifecycleVersion += 1;
    await this.#dispose();
  }

  async #dispose(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#state = "stopped";
    this.#tools = [];
    for (const call of this.#calls.values()) {
      if (call.view.state === "pending") call.view = { ...call.view, state: "unknown", error: "HOST_CLOSED" };
    }
    await client?.close().catch(() => undefined);
  }
}
