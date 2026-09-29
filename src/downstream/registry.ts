import { DownstreamMcpClient } from "./client.js";
import type {
  DownstreamDefinition,
  DownstreamStatus,
  DownstreamWorkspaceContext
} from "./types.js";

export class DownstreamRegistry {
  private readonly clients = new Map<string, DownstreamMcpClient>();

  constructor(
    definitions: readonly DownstreamDefinition[],
    workspaceContext: () => DownstreamWorkspaceContext,
    private readonly allowed: (definition: DownstreamDefinition) => boolean = () => true
  ) {
    for (const definition of definitions) {
      if (this.clients.has(definition.id)) {
        throw new Error(`Duplicate downstream MCP id: ${definition.id}`);
      }
      this.clients.set(
        definition.id,
        new DownstreamMcpClient(definition, workspaceContext)
      );
    }
  }

  private get(id: string): DownstreamMcpClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Unknown downstream MCP server: ${id}`);
    if (!this.allowed(client.definition)) {
      throw new Error(`Downstream MCP "${id}" is not available for the active workspace.`);
    }
    return client;
  }

  statuses(): DownstreamStatus[] {
    return [...this.clients.values()].map((client) => ({
      ...client.status(),
      available: this.allowed(client.definition)
    }));
  }

  listTools(id: string) {
    return this.get(id).listTools();
  }

  callTool(id: string, tool: string, args: Record<string, unknown> = {}) {
    return this.get(id).callTool(tool, args);
  }

  async close(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Unknown downstream MCP server: ${id}`);
    await client.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
  }
}
