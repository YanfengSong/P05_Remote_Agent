import { DownstreamMcpClient } from "./client.js";
import type { DownstreamDefinition, DownstreamStatus } from "./types.js";

export class DownstreamRegistry {
  private readonly clients = new Map<string, DownstreamMcpClient>();

  constructor(definitions: DownstreamDefinition[]) {
    for (const definition of definitions) {
      this.clients.set(definition.id, new DownstreamMcpClient(definition));
    }
  }

  private get(id: string): DownstreamMcpClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Unknown downstream MCP server: ${id}`);
    return client;
  }

  statuses(): DownstreamStatus[] {
    return [...this.clients.values()].map((client) => client.status());
  }

  listTools(id: string) {
    return this.get(id).listTools();
  }

  callTool(id: string, tool: string, args: Record<string, unknown> = {}) {
    return this.get(id).callTool(tool, args);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
  }
}
