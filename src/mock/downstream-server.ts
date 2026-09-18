import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

serveStdio(() => {
  const server = new McpServer({ name: "remote-agent-mock", version: "0.1.0" });

  server.registerTool("echo", {
    description: "Echo a message for gateway smoke testing.",
    inputSchema: z.object({ message: z.string() })
  }, async ({ message }) => ({
    content: [{ type: "text", text: message }]
  }));

  return server;
});
