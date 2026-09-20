import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";
import {
  resolveDownstreamTarget,
  type DownstreamDefinition,
  type DownstreamStatus,
  type DownstreamTool,
  type DownstreamWorkspaceContext
} from "./types.js";

function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return { ...env, ...extra };
}

function describeConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/i.test(message)) return "command not found";
  if (/EACCES|EPERM/i.test(message)) return "access denied";
  if (/timed?\s?out|ETIMEDOUT/i.test(message)) return "timed out";
  if (/ECONNREFUSED/i.test(message)) return "connection refused";
  return "connection failed";
}

export const CONNECT_ERROR_CATEGORIES = [
  "command not found",
  "access denied",
  "timed out",
  "connection refused",
  "connection failed"
] as const;

export class DownstreamMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connected = false;
  private lastError?: string;
  private bindingKey?: string;
  private boundWorkspaceId?: string;

  constructor(
    readonly definition: DownstreamDefinition,
    private readonly workspaceContext: () => DownstreamWorkspaceContext
  ) {}

  status(): DownstreamStatus {
    const binding = this.definition.workspaceBinding ?? "active";
    let boundWorkspaceId = this.boundWorkspaceId;
    if (!boundWorkspaceId && binding !== "fixed") {
      try {
        boundWorkspaceId = resolveDownstreamTarget(this.definition, this.workspaceContext()).workspaceId;
      } catch {
        // Status should remain inspectable even when a target is misconfigured.
      }
    }

    return {
      id: this.definition.id,
      label: this.definition.label,
      ...(this.definition.pluginId ? { pluginId: this.definition.pluginId } : {}),
      available: true,
      enabled: this.definition.enabled,
      configured: Boolean(this.definition.command),
      connected: this.connected,
      workspaceBinding: binding,
      ...(boundWorkspaceId ? { boundWorkspaceId } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  async connect(): Promise<void> {
    if (!this.definition.enabled) throw new Error(`${this.definition.id} is disabled.`);
    if (!this.definition.command) throw new Error(`${this.definition.id} command is not configured.`);

    const target = resolveDownstreamTarget(this.definition, this.workspaceContext());
    if (this.connected && this.bindingKey === target.bindingKey) return;
    if (this.connected) await this.close();

    const client = new Client({ name: "p05-remote-agent", version: VERSION });
    const transport = new StdioClientTransport({
      command: this.definition.command,
      args: this.definition.args ?? [],
      cwd: target.cwd,
      env: inheritedEnv(this.definition.env)
    });

    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.connected = true;
      this.bindingKey = target.bindingKey;
      this.boundWorkspaceId = target.workspaceId;
      this.lastError = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[p05] downstream "${this.definition.id}" connect failed: ${detail}`);
      await client.close().catch(() => undefined);
      this.lastError = describeConnectError(error);
      this.connected = false;
      this.bindingKey = undefined;
      this.boundWorkspaceId = undefined;
      throw new Error(this.lastError);
    }
  }

  async listTools(): Promise<DownstreamTool[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return this.client!.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close().catch(() => undefined);
    this.client = undefined;
    this.transport = undefined;
    this.connected = false;
    this.bindingKey = undefined;
    this.boundWorkspaceId = undefined;
  }
}