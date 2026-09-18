import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";
import type { DownstreamDefinition, DownstreamStatus, DownstreamTool } from "./types.js";

function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return { ...env, ...extra };
}

/**
 * A connect failure ends up in a response the remote can read (`mcp_status.lastError`,
 * and the error text of `mcp_list_tools` / `mcp_call_tool`), and a raw spawn error carries
 * the absolute command path. Classify it into a short category instead, and keep the
 * real message on the operator's stderr.
 *
 * The classification is deliberately coarse: the transport reports a child that never
 * started as "Connection closed" rather than ENOENT (observed on Windows against a
 * missing executable), so the ENOENT/EACCES branches only fire when the underlying error
 * does survive. The contract is "a short category with no path in it", not a precise
 * diagnosis.
 */
function describeConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/i.test(message)) return "command not found";
  if (/EACCES|EPERM/i.test(message)) return "access denied";
  if (/timed?\s?out|ETIMEDOUT/i.test(message)) return "timed out";
  if (/ECONNREFUSED/i.test(message)) return "connection refused";
  return "connection failed";
}

/** The categories above; exported so the exposure test asserts the same closed set. */
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

    const client = new Client({ name: "p05-remote-agent", version: VERSION });
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
      const detail = error instanceof Error ? error.message : String(error);
      // The operator gets the real error; the remote gets the short category.
      console.error(`[p05] downstream "${this.definition.id}" connect failed: ${detail}`);
      await client.close().catch(() => undefined);
      this.lastError = describeConnectError(error);
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
  }
}
