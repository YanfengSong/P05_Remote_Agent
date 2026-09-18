import * as z from "zod/v4";
import { DownstreamRegistry } from "./downstream/registry.js";
import type { Exposer } from "./policy/expose.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerGatewayTools(exposer: Exposer, registry: DownstreamRegistry): void {
  exposer.expose("mcp_status", {
    description: "Show configured downstream MCP servers and their connection state.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: asText(registry.statuses()) }]
  }));

  exposer.expose("mcp_list_tools", {
    description: "Connect to a downstream MCP server and list its tools.",
    inputSchema: z.object({ server: z.string().min(1) })
  }, async ({ server: serverId }) => ({
    content: [{ type: "text", text: asText(await registry.listTools(serverId)) }]
  }));

  exposer.expose("mcp_call_tool", {
    description: "Call one tool on a configured downstream MCP server.",
    inputSchema: z.object({
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional()
    })
  }, async ({ server: serverId, tool, arguments: args }) => ({
    content: [{
      type: "text",
      text: asText(await registry.callTool(serverId, tool, args ?? {}))
    }]
  }));
}
