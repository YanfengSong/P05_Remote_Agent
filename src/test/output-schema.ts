import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CAPABILITIES } from "../capability/registry.js";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const serverEntry = path.resolve(here, "..", "index.js");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_")) env[key] = value;
  }
  env.REMOTE_AGENT_ALLOWED_ROOTS = REPO;
  env.REMOTE_AGENT_DEFAULT_CWD = REPO;
  env.P05_TOOL_PROFILE = "full";
  env.MATLAB_MCP_ENABLED = "false";
  return env;
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : undefined;
}

const client = new Client({ name: "p05-output-schema-test", version: VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: inheritedEnv(),
  stderr: "pipe"
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = CAPABILITIES.map((capability) => capability.name).sort();

  check(
    "output-schema: full surface covers every Core capability",
    names.join(",") === expected.join(","),
    `expected ${expected.length}, got ${names.length}`
  );

  for (const tool of listed.tools) {
    const schema = tool.outputSchema as { type?: unknown; properties?: unknown } | undefined;
    check(`output-schema: ${tool.name} advertises outputSchema`, Boolean(schema), JSON.stringify(tool));
    check(
      `output-schema: ${tool.name} outputSchema has object root`,
      schema?.type === "object",
      JSON.stringify(schema)
    );
  }

  const samples: Array<[string, Record<string, unknown>]> = [
    ["device_info", {}],
    ["ping", {}],
    ["workspace_list", {}],
    ["workspace_current", {}],
    ["activity_recent", { limit: 5 }],
    ["plugin_list", {}],
    ["recovery_status", { limit: 5 }],
    ["fs_list", { path: "." }],
    ["fs_read", { path: "README.md" }],
    ["git_status", {}],
    ["git_diff_stat", {}],
    ["command_run", { action: "check" }],
    ["shell_run", { command: "Write-Output p05-structured-output" }],
    ["mcp_status", {}]
  ];

  for (const [name, args] of samples) {
    const result = await client.callTool({ name, arguments: args });
    const structured = structuredOf(result);
    check(`structured-content: ${name} returns an object`, Boolean(structured), JSON.stringify(result).slice(0, 400));
  }

  console.log(`OUTPUT_SCHEMA_OK (${checks} checks)`);
} finally {
  await client.close().catch(() => undefined);
}
