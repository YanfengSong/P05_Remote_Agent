import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getDeviceInfo, getPingInfo } from "../device/identity.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerDeviceTools(server: McpServer): void {
  server.registerTool("device_info", {
    description: "Return the identity and basic runtime information for this P05 Remote Agent computer.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: asText(getDeviceInfo()) }]
  }));

  server.registerTool("ping", {
    description: "Confirm that this P05 Remote Agent computer is online and responding.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: asText(getPingInfo()) }]
  }));
}
