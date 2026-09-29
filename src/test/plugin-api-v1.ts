import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const fixture = path.join(repo, "_p05_plugin_api_v1_test");
const stateDir = path.join(fixture, ".state");
const serverEntry = path.resolve(here, "..", "index.js");

await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) {
    throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
  }
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (
    typeof value === "string" &&
    !key.startsWith("P05_") &&
    !key.startsWith("MATLAB_") &&
    key !== "REMOTE_AGENT_ALLOWED_ROOTS" &&
    key !== "REMOTE_AGENT_DEFAULT_CWD"
  ) {
    env[key] = value;
  }
}
Object.assign(env, {
  REMOTE_AGENT_ALLOWED_ROOTS: fixture,
  REMOTE_AGENT_DEFAULT_CWD: fixture,
  P05_STATE_DIR: stateDir,
  P05_TOOL_PROFILE: "readonly",
  P05_EXAMPLE_PLUGIN_ENABLED: "true",
  MATLAB_MCP_ENABLED: "false"
});

const client = new Client({
  name: "p05-plugin-api-v1-smoke",
  version: VERSION
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env,
  stderr: "pipe"
});

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  check(
    "plugin-api-v1: example tool is exposed through real MCP server",
    names.includes("example.echo"),
    names.join(",")
  );

  const result = await client.callTool({
    name: "example.echo",
    arguments: { message: "hello-plugin-v1" }
  });
  const structured = result.structuredContent as
    | { plugin?: string; message?: string; workspaceId?: string }
    | undefined;

  check(
    "plugin-api-v1: example tool returns structured result",
    structured?.plugin === "example" &&
      structured.message === "hello-plugin-v1" &&
      typeof structured.workspaceId === "string",
    JSON.stringify(structured)
  );

  const plugins = await client.callTool({
    name: "plugin_list",
    arguments: {}
  });
  const pluginStructured = plugins.structuredContent as
    | { plugins?: Array<{ id?: string; enabled?: boolean; state?: string }> }
    | undefined;
  const exampleView = pluginStructured?.plugins?.find(
    (plugin) => plugin.id === "example"
  );

  check(
    "plugin-api-v1: example plugin appears in plugin_list",
    exampleView?.enabled === true,
    JSON.stringify(exampleView)
  );
  check(
    "plugin-api-v1: example plugin reaches running state",
    exampleView?.state === "running",
    JSON.stringify(exampleView)
  );

  console.log(`PLUGIN_API_V1_OK (${checks} checks)`);
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}
