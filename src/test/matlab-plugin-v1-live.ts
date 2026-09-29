import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const fixture = path.join(repo, "_p05_matlab_plugin_v1_live");
const stateDir = path.join(fixture, ".state");
const serverEntry = path.resolve(here, "..", "index.js");
const toolkitRoot =
  process.env.MATLAB_AGENTIC_TOOLKIT_ROOT?.trim() ||
  path.join(os.homedir(), ".matlab", "agentic-toolkits");
const matlabMcp = path.join(toolkitRoot, "bin", "matlab-mcp-server.exe");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) {
    throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
  }
}

try {
  await fs.access(matlabMcp);
} catch {
  console.log("MATLAB_PLUGIN_V1_LIVE_SKIPPED (MathWorks MCP server not installed)");
  process.exit(0);
}

await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (
    typeof value === "string" &&
    !key.startsWith("P05_") &&
    key !== "REMOTE_AGENT_ALLOWED_ROOTS" &&
    key !== "REMOTE_AGENT_DEFAULT_CWD"
  ) {
    env[key] = value;
  }
}

Object.assign(env, {
  REMOTE_AGENT_ALLOWED_ROOTS: repo,
  REMOTE_AGENT_DEFAULT_CWD: repo,
  P05_STATE_DIR: stateDir,
  P05_TOOL_PROFILE: "developer",
  P05_EXAMPLE_PLUGIN_ENABLED: "false",
  MATLAB_MCP_ENABLED: "true",
  MATLAB_MCP_WORKSPACE_BINDING: "active",
  MATLAB_MCP_AUTO_SIMULINK: "true",
  MATLAB_MCP_TIMEOUT_MS: "600000"
});

const client = new Client({
  name: "p05-matlab-plugin-v1-live",
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

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  check(
    "matlab-v1-live: migrated MATLAB tools are exposed",
    names.includes("matlab.call_tool") &&
      names.includes("matlab.skill_list") &&
      names.includes("matlab.skill_read"),
    names.join(",")
  );

  const skillList = await client.callTool({
    name: "matlab.skill_list",
    arguments: { limit: 5 }
  });
  const skillStructured = skillList.structuredContent as
    | { total?: number; count?: number; skills?: Array<{ id?: string }> }
    | undefined;
  check(
    "matlab-v1-live: real MathWorks skill catalog is readable",
    typeof skillStructured?.total === "number" &&
      typeof skillStructured?.count === "number" &&
      Array.isArray(skillStructured?.skills),
    JSON.stringify(skillStructured)
  );

  const firstSkillId = skillStructured?.skills?.find(
    (skill) => typeof skill.id === "string"
  )?.id;
  check(
    "matlab-v1-live: at least one real MathWorks skill is discovered",
    typeof firstSkillId === "string" && firstSkillId.length > 0,
    JSON.stringify(skillStructured)
  );

  const skillRead = await client.callTool({
    name: "matlab.skill_read",
    arguments: { id: firstSkillId! }
  });
  const skillReadStructured = skillRead.structuredContent as
    | { id?: string; content?: string }
    | undefined;
  check(
    "matlab-v1-live: real MathWorks skill content is readable",
    skillReadStructured?.id === firstSkillId &&
      typeof skillReadStructured?.content === "string" &&
      (skillReadStructured?.content?.length ?? 0) > 0,
    JSON.stringify(skillReadStructured)
  );

  const downstreamTools = await client.callTool(
    {
      name: "mcp_list_tools",
      arguments: { server: "matlab" }
    },
    { timeout: 600_000, maxTotalTimeout: 600_000 }
  );
  const downstreamStructured = downstreamTools.structuredContent as
    | { tools?: Array<{ name?: string }> }
    | undefined;
  check(
    "matlab-v1-live: real MathWorks downstream tools are discoverable",
    downstreamStructured?.tools?.some(
      (tool) => tool.name === "evaluate_matlab_code"
    ) === true,
    JSON.stringify(downstreamStructured)
  );

  const boundaryResult = await client.callTool({
    name: "matlab.call_tool",
    arguments: {
      tool: "evaluate_matlab_code",
      arguments: {
        project_path: path.parse(repo).root,
        code: "disp(1);"
      }
    }
  });
  const boundaryText = JSON.stringify(boundaryResult);
  check(
    "matlab-v1-live: workspace escape is rejected before downstream execution",
    boundaryResult.isError === true &&
      boundaryText.includes("outside the active workspace"),
    boundaryText
  );

  const evaluate = await client.callTool(
    {
      name: "matlab.call_tool",
      arguments: {
        tool: "evaluate_matlab_code",
        arguments: {
          code: "p05_plugin_v1_pressure_value = 6 * 7; disp(p05_plugin_v1_pressure_value);"
        }
      }
    },
    { timeout: 600_000, maxTotalTimeout: 600_000 }
  );

  const evaluateStructured = evaluate.structuredContent as
    | { result?: unknown }
    | undefined;
  check(
    "matlab-v1-live: PluginContext downstream executes real MATLAB MCP tool",
    evaluateStructured !== undefined &&
      Object.prototype.hasOwnProperty.call(evaluateStructured, "result"),
    JSON.stringify(evaluateStructured)
  );

  const plugins = await client.callTool({
    name: "plugin_list",
    arguments: {}
  });
  const pluginStructured = plugins.structuredContent as
    | { plugins?: Array<{ id?: string; state?: string; downstreamIds?: string[] }> }
    | undefined;
  const matlab = pluginStructured?.plugins?.find((plugin) => plugin.id === "matlab");
  check(
    "matlab-v1-live: MATLAB plugin remains running and owns downstream",
    matlab?.state === "running" && matlab.downstreamIds?.includes("matlab") === true,
    JSON.stringify(matlab)
  );

  console.log(`MATLAB_PLUGIN_V1_LIVE_OK (${checks} checks)`);
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}
