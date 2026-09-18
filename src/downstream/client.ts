import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { DownstreamDefinition, DownstreamStatus, DownstreamTool } from "./types.js";

function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return { ...env, ...extra };
}

export class DownstreamMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connected = false;
  private lastError?: string;

  constructor(readonly definition: DownstreamDefinition) {}

  status(): DownstreamStatus {
    return {
      id: this.definition.id,
      label: this.definition.label,
      enabled: this.definition.enabled,
      configured: Boolean(this.definition.command),
      connected: this.connected,
      lastError: this.lastError
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.definition.enabled) throw new Error(`${this.definition.id} is disabled.`);
    if (!this.definition.command) throw new Error(`${this.definition.id} command is not configured.`);

    const client = new Client({ name: "p05-remote-agent", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: this.definition.command,
      args: this.definition.args ?? [],
      cwd: this.definition.cwd,
      env: inheritedEnv(this.definition.env)
    });

    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.connected = true;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await client.close().catch(() => undefined);
      throw error;
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
  }
}
