import path from "node:path";
import { fileURLToPath } from "node:url";
import { DownstreamMcpClient } from "../downstream/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../mock/downstream-server.js");

const client = new DownstreamMcpClient({
  id: "mock",
  label: "Smoke Test MCP",
  enabled: true,
  command: process.execPath,
  args: [serverPath],
  workspaceBinding: "active"
}, () => ({
  active: { id: "smoke", root: here },
  platform: { id: "smoke-platform", root: here }
}));

try {
  const tools = await client.listTools();
  if (!tools.some((tool) => tool.name === "echo")) throw new Error("echo tool not discovered");

  const result = await client.callTool("echo", { message: "gateway-ok" });
  const text = JSON.stringify(result);
  if (!text.includes("gateway-ok")) throw new Error("echo result mismatch");

  console.log("DOWNSTREAM_SMOKE_OK");
} finally {
  await client.close();
}
