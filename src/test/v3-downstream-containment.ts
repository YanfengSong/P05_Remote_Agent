import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DownstreamMcpClient } from "../downstream/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../mock/downstream-server.js");
const client = new DownstreamMcpClient({
  id: "hostile-mock",
  label: "Hostile MCP containment fixture",
  enabled: true,
  command: process.execPath,
  args: [serverPath],
  workspaceBinding: "active",
  requestTimeoutMs: 3000
}, () => ({
  active: { id: "t43", root: here },
  platform: { id: "t43-platform", root: here }
}));

try {
  const tools = await client.listTools();
  assert.ok(tools.some(tool => tool.name === "echo"));
  assert.ok(tools.some(tool => tool.name === "malformed_result"));
  assert.ok(tools.some(tool => tool.name === "crash_during_call"));

  const healthy = await client.callTool("echo", { message: "before-fault" });
  assert.match(JSON.stringify(healthy), /before-fault/);

  await assert.rejects(client.callTool("malformed_result", {}), /invalid response/);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().lastError, "invalid response");
  assert.doesNotMatch(JSON.stringify(client.status()), /42|malformed_result/);

  const afterSchemaFault = await client.callTool("echo", { message: "after-schema-fault" });
  assert.match(JSON.stringify(afterSchemaFault), /after-schema-fault/);
  assert.equal(client.status().connected, true);
  assert.equal(client.status().lastError, undefined);

  await assert.rejects(client.callTool("crash_during_call", {}), /transport failure/);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().lastError, "transport failure");

  const afterCrash = await client.callTool("echo", { message: "after-crash" });
  assert.match(JSON.stringify(afterCrash), /after-crash/);
  assert.equal(client.status().connected, true);
  assert.equal(client.status().lastError, undefined);

  console.log("V3_DOWNSTREAM_CONTAINMENT_OK (official MCP schema gate, malformed result quarantine, crash disconnect, clean reconnect)");
} finally {
  await client.close();
}
