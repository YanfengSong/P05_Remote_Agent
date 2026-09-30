import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { VERSION } from "../version.js";

serveStdio(() => {
  const server = new McpServer({ name: "remote-agent-mock", version: VERSION });

  server.registerTool("echo", {
    description: "Echo a message for gateway smoke testing.",
    inputSchema: z.object({ message: z.string() })
  }, async ({ message }) => ({
    content: [{ type: "text", text: message }]
  }));

  server.registerTool("malformed_result", {
    description: "Return a deliberately invalid MCP result for containment acceptance.",
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: "text", text: 42 }] } as any));

  server.registerTool("crash_during_call", {
    description: "Terminate the downstream process during a call for containment acceptance.",
    inputSchema: z.object({})
  }, async () => {
    process.exit(17);
  });

  return server;
});
