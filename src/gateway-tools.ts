import * as z from "zod/v4";
import { DownstreamRegistry } from "./downstream/registry.js";
import type { Exposer } from "./policy/expose.js";
import { structuredResult } from "./tools/result.js";

const downstreamStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  pluginId: z.string().optional(),
  available: z.boolean(),
  enabled: z.boolean(),
  configured: z.boolean(),
  connected: z.boolean(),
  workspaceBinding: z.enum(["active", "platform", "fixed"]),
  boundWorkspaceId: z.string().optional(),
  lastError: z.string().optional()
});

const downstreamToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional()
});

export function registerGatewayTools(
  exposer: Exposer,
  registry: DownstreamRegistry
): void {
  exposer.expose("mcp_status", {
    description: "Show downstream MCP state and workspace-binding mode.",
    inputSchema: z.object({}),
    outputSchema: z.object({ servers: z.array(downstreamStatusSchema) })
  }, async () => {
    const servers = registry.statuses();
    return structuredResult({ servers }, JSON.stringify(servers, null, 2));
  });

  exposer.expose("mcp_list_tools", {
    description: "Connect to a downstream MCP server using its workspace binding and list its tools.",
    inputSchema: z.object({ server: z.string().min(1) }),
    outputSchema: z.object({ tools: z.array(downstreamToolSchema) })
  }, async ({ server: serverId }) => {
    const tools = await registry.listTools(serverId);
    return structuredResult({ tools }, JSON.stringify(tools, null, 2));
  });

  exposer.expose("mcp_call_tool", {
    description: "Call one tool on a configured downstream MCP server using its workspace binding.",
    inputSchema: z.object({
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional()
    }),
    outputSchema: z.object({ result: z.unknown() })
  }, async ({ server: serverId, tool, arguments: args }) => {
    const result = await registry.callTool(serverId, tool, args ?? {});
    return structuredResult({ result }, JSON.stringify(result, null, 2));
  });
}
