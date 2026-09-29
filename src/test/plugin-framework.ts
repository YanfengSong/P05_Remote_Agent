import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, CapabilityCatalog } from "../capability/registry.js";
import type { ApplicationPlugin } from "../plugin/types.js";
import { PLUGIN_API_VERSION } from "../plugin/types.js";
import { PluginRegistry } from "../plugin/registry.js";
import { PluginRuntime } from "../plugin/runtime.js";
import type { Exposer } from "../policy/expose.js";
import { isToolAllowed } from "../policy/tool-profile.js";
import {
  createMatlabDownstreamDefinition,
  discoverMatlabAgenticToolkit,
  guardMatlabWorkspaceArguments,
  matlabPlugin
} from "../plugins/matlab/plugin.js";
import { MatlabSkillCatalog } from "../plugins/matlab/skills.js";
import { parseWorkspaceRegistry, WorkspaceManager } from "../workspace/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_plugin_test");
const PLATFORM = path.join(FIXTURE, "platform");
const BUSINESS = path.join(FIXTURE, "business");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}
function throws(label: string, fn: () => unknown, mustContain?: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, mustContain ? message.includes(mustContain) : true, message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected throw`);
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(PLATFORM, { recursive: true });
await fs.mkdir(BUSINESS, { recursive: true });

try {
  const workspaces = parseWorkspaceRegistry(JSON.stringify([
    { id: "p05", root: PLATFORM, kind: "platform-source", plugins: ["demo"] },
    { id: "business", root: BUSINESS, kind: "git-project", plugins: [] }
  ]), [FIXTURE], PLATFORM);
  const manager = new WorkspaceManager(workspaces, "p05");

  const emptyRegistry = new PluginRegistry([]);
  const emptyRuntime = new PluginRuntime(emptyRegistry, manager);
  check("plugin: Core supports zero application plugins", emptyRuntime.list().length === 0);
  check("plugin: no arbitrary path loader is exposed",
    typeof (emptyRegistry as unknown as Record<string, unknown>).loadFromPath === "undefined");

  const demo: ApplicationPlugin = {
    manifest: {
      id: "demo",
      label: "Demo",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      enabled: true,
      capabilities: [{
        name: "demo.echo",
        minProfile: "developer",
        risk: "read",
        scope: "workspace",
        summary: "Demo plugin echo capability for framework validation."
      }],
      permissions: { workspace: "active", hostEffects: "none" }
    },
    downstreamDefinitions: () => [{
      id: "demo-mcp",
      label: "Demo MCP",
      enabled: false,
      workspaceBinding: "active"
    }],
    registerTools: (exposer) => {
      exposer.expose(
        "demo.echo",
        {} as never,
        (async () => ({
          content: [{ type: "text" as const, text: "demo-ok" }]
        })) as never
      );
    }
  };

  const registry = new PluginRegistry([demo]);
  const runtime = new PluginRuntime(registry, manager);
  const catalog = new CapabilityCatalog(CAPABILITIES);
  catalog.registerMany(registry.capabilities(), "plugin-test");

  check("plugin: capability enters merged catalog", catalog.descriptor("demo.echo").scope === "workspace");
  check("plugin: merged capability obeys normal profile policy",
    isToolAllowed("developer", "demo.echo", catalog) && !isToolAllowed("readonly", "demo.echo", catalog));
  check("plugin: platform workspace allowlist enables demo", runtime.isAllowedForCurrentWorkspace("demo"));

  let capturedHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
  const fakeExposer: Exposer = {
    expose: ((name: string, _config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
      check("plugin: declared tool registers through Core Exposer", name === "demo.echo", name);
      capturedHandler = handler;
    }) as Exposer["expose"],
    report: () => ({
      profile: "developer",
      profileSource: "env",
      exposed: [],
      suppressed: []
    })
  };
  runtime.registerTools(fakeExposer);
  check("plugin: Core wrapper permits plugin tool in allowed workspace",
    Boolean(capturedHandler && await capturedHandler()));

  await runtime.start("demo");
  check("plugin-control: single plugin can start",
    runtime.list().find((plugin) => plugin.id === "demo")?.state === "running");
  await runtime.stop("demo");
  check("plugin-control: single plugin can stop",
    runtime.list().find((plugin) => plugin.id === "demo")?.state === "stopped" &&
    !runtime.isAllowedForCurrentWorkspace("demo"));
  await runtime.start("demo");
  check("plugin-control: stopped plugin can restart",
    runtime.list().find((plugin) => plugin.id === "demo")?.state === "running");

  check("plugin: downstream contribution carries owning plugin id",
    registry.downstreamDefinitions()[0]?.pluginId === "demo");

  manager.switch("business");
  check("plugin: business workspace can disable demo", !runtime.isAllowedForCurrentWorkspace("demo"));
  if (!capturedHandler) throw new Error("FAIL plugin: wrapped handler was not registered");
  let guardedFailure = "";
  try {
    await capturedHandler();
  } catch (error) {
    guardedFailure = error instanceof Error ? error.message : String(error);
  }
  check("plugin: Core wrapper refuses plugin tool after workspace switch",
    guardedFailure.includes("not enabled for workspace"), guardedFailure);
  throws("plugin: workspace-disabled plugin call is refused",
    () => runtime.assertAllowedForCurrentWorkspace("demo"), "not enabled for workspace");

  const badPrefix: ApplicationPlugin = {
    ...demo,
    manifest: {
      ...demo.manifest,
      id: "badprefix",
      capabilities: [{ ...demo.manifest.capabilities[0]!, name: "other.echo" }]
    }
  };
  throws("plugin: capability prefix is enforced", () => new PluginRegistry([badPrefix]), "must use");

  const badHost: ApplicationPlugin = {
    ...demo,
    manifest: {
      ...demo.manifest,
      id: "badhost",
      capabilities: [{
        name: "badhost.admin",
        minProfile: "full",
        risk: "write",
        scope: "host",
        summary: "Invalid host capability for validation."
      }]
    }
  };
  throws("plugin: manifest cannot silently claim host authority",
    () => new PluginRegistry([badHost]), "hostEffects=none");

  const badApi = {
    ...demo,
    manifest: { ...demo.manifest, id: "badapi", apiVersion: "999" }
  } as unknown as ApplicationPlugin;
  throws("plugin: incompatible API version fails closed",
    () => new PluginRegistry([badApi]), "supported API");

  const missingCapability: ApplicationPlugin = {
    ...demo,
    manifest: {
      ...demo.manifest,
      id: "missingcap",
      capabilities: []
    },
    tools: [{
      name: "missingcap.echo",
      handler: () => ({ content: [{ type: "text" as const, text: "bad" }] })
    }]
  };
  throws(
    "plugin-api-v1: declarative tool without matching capability fails closed",
    () => new PluginRegistry([missingCapability]),
    "matching manifest capability"
  );

  const failing: ApplicationPlugin = {
    manifest: {
      id: "failing",
      label: "Failing",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      enabled: true,
      capabilities: [],
      permissions: { workspace: "active", hostEffects: "none" }
    },
    start: () => { throw new Error("boom"); }
  };
  const failureRuntime = new PluginRuntime(new PluginRegistry([failing]), manager);
  await failureRuntime.startAll();
  check("plugin: start failure is isolated",
    failureRuntime.list()[0]?.state === "failed", JSON.stringify(failureRuntime.list()));

  const matlabRegistry = new PluginRegistry([matlabPlugin]);
  const matlabDefs = matlabRegistry.downstreamDefinitions();
  check("plugin: MATLAB contributes downstream through Plugin Registry",
    matlabDefs.length === 1 && matlabDefs[0]?.pluginId === "matlab" && matlabDefs[0]?.id === "matlab");
  const matlabAsPlugin: ApplicationPlugin = matlabPlugin;
  check(
    "plugin-api-v1: MATLAB uses declarative tools instead of legacy registerTools",
    Array.isArray(matlabAsPlugin.tools) &&
      matlabAsPlugin.tools.length === 3 &&
      matlabAsPlugin.registerTools === undefined,
    JSON.stringify({
      toolCount: matlabAsPlugin.tools?.length,
      legacyRegisterTools: typeof matlabAsPlugin.registerTools
    })
  );

  const toolkitRoot = path.join(FIXTURE, "agentic-toolkits");
  const toolkitBin = path.join(toolkitRoot, "bin");
  const simulinkTools = path.join(toolkitRoot, "simulink", "tools");
  const matlabSkillDir = path.join(
    toolkitRoot,
    "matlab",
    "skills-catalog",
    "matlab-core",
    "matlab-demo"
  );
  const simulinkSkillDir = path.join(
    toolkitRoot,
    "simulink",
    "skills-catalog",
    "model-based-design-core",
    "simulink-demo"
  );
  await fs.mkdir(toolkitBin, { recursive: true });
  await fs.mkdir(simulinkTools, { recursive: true });
  await fs.mkdir(matlabSkillDir, { recursive: true });
  await fs.mkdir(simulinkSkillDir, { recursive: true });
  const toolkitCommand = path.join(
    toolkitBin,
    process.platform === "win32" ? "matlab-mcp-server.exe" : "matlab-mcp-server"
  );
  const simulinkExtension = path.join(simulinkTools, "tools.json");
  await fs.writeFile(toolkitCommand, "", "utf8");
  await fs.writeFile(simulinkExtension, "{}", "utf8");
  await fs.writeFile(
    path.join(matlabSkillDir, "SKILL.md"),
    [
      "---",
      "name: matlab-demo",
      "description: >",
      "  Demo MATLAB skill for catalog validation.",
      "metadata:",
      "  author: MathWorks",
      "  version: \"1.2\"",
      "---",
      "",
      "# MATLAB Demo",
      "",
      "Use evaluate_matlab_code."
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(simulinkSkillDir, "SKILL.md"),
    [
      "---",
      "name: simulink-demo",
      "description: Demo Simulink skill for model workflows.",
      "metadata:",
      "  author: MathWorks",
      "  version: \"2.0\"",
      "---",
      "",
      "# Simulink Demo",
      "",
      "Use model_read before model_edit."
    ].join("\n"),
    "utf8"
  );

  const matlabEnvKeys = [
    "MATLAB_AGENTIC_TOOLKIT_ROOT",
    "MATLAB_MCP_COMMAND",
    "MATLAB_MCP_ARGS_JSON",
    "MATLAB_MCP_AUTO_SIMULINK",
    "MATLAB_MCP_TIMEOUT_MS"
  ] as const;
  const previousMatlabEnv = Object.fromEntries(
    matlabEnvKeys.map((key) => [key, process.env[key]])
  ) as Record<(typeof matlabEnvKeys)[number], string | undefined>;
  try {
    process.env.MATLAB_AGENTIC_TOOLKIT_ROOT = toolkitRoot;
    delete process.env.MATLAB_MCP_COMMAND;
    delete process.env.MATLAB_MCP_ARGS_JSON;
    delete process.env.MATLAB_MCP_AUTO_SIMULINK;
    delete process.env.MATLAB_MCP_TIMEOUT_MS;

    const discovery = discoverMatlabAgenticToolkit();
    check(
      "plugin: MATLAB discovers managed Agentic Toolkit MCP server",
      discovery.command === path.resolve(toolkitCommand),
      JSON.stringify(discovery)
    );
    check(
      "plugin: MATLAB discovers Simulink MCP extension",
      discovery.simulinkExtension === path.resolve(simulinkExtension),
      JSON.stringify(discovery)
    );

    const autoDefinition = createMatlabDownstreamDefinition();
    check(
      "plugin: MATLAB auto-configures managed MCP command",
      autoDefinition.command === path.resolve(toolkitCommand),
      String(autoDefinition.command)
    );
    check(
      "plugin: MATLAB auto-loads Simulink extension",
      autoDefinition.args?.includes(`--extension-file=${path.resolve(simulinkExtension)}`) === true,
      JSON.stringify(autoDefinition.args)
    );
    check(
      "plugin: MATLAB defaults to auto session and 10 minute timeout",
      autoDefinition.args?.includes("--matlab-session-mode=auto") === true &&
      autoDefinition.requestTimeoutMs === 600_000,
      JSON.stringify(autoDefinition)
    );

    const skillCatalog = new MatlabSkillCatalog(toolkitRoot);
    check(
      "plugin: MATLAB skill catalog discovers MATLAB and Simulink skills",
      skillCatalog.count() === 2 &&
      skillCatalog.list({ source: "matlab" })[0]?.id === "matlab-demo" &&
      skillCatalog.list({ source: "simulink" })[0]?.id === "simulink-demo",
      JSON.stringify(skillCatalog.list({ limit: 10 }))
    );
    check(
      "plugin: MATLAB skill catalog searches metadata",
      skillCatalog.list({ query: "model workflows" })[0]?.id === "simulink-demo",
      JSON.stringify(skillCatalog.list({ query: "model workflows" }))
    );
    const skill = skillCatalog.read("MATLAB-DEMO");
    check(
      "plugin: MATLAB skill catalog reads skill content by stable id",
      skill.version === "1.2" &&
      skill.description === "Demo MATLAB skill for catalog validation." &&
      skill.content.includes("# MATLAB Demo"),
      JSON.stringify(skill)
    );

    process.env.MATLAB_MCP_COMMAND = path.join(FIXTURE, "explicit-matlab-mcp");
    const overriddenDefinition = createMatlabDownstreamDefinition();
    check(
      "plugin: explicit MATLAB MCP command overrides toolkit discovery",
      overriddenDefinition.command === process.env.MATLAB_MCP_COMMAND,
      String(overriddenDefinition.command)
    );

    delete process.env.MATLAB_MCP_COMMAND;
    process.env.MATLAB_MCP_AUTO_SIMULINK = "false";
    const noSimulinkDefinition = createMatlabDownstreamDefinition();
    check(
      "plugin: automatic Simulink extension can be disabled explicitly",
      !noSimulinkDefinition.args?.some((arg) => arg.startsWith("--extension-file=")),
      JSON.stringify(noSimulinkDefinition.args)
    );
  } finally {
    for (const key of matlabEnvKeys) {
      const value = previousMatlabEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const guardedMatlabArgs = guardMatlabWorkspaceArguments({
    project_path: BUSINESS,
    script_path: path.join(BUSINESS, "script.m"),
    model: "model.slx"
  }, BUSINESS);
  check(
    "plugin: MATLAB workspace guard keeps in-workspace paths",
    guardedMatlabArgs.project_path === path.resolve(BUSINESS) &&
    guardedMatlabArgs.script_path === path.resolve(BUSINESS, "script.m") &&
    guardedMatlabArgs.model === "model.slx"
  );
  throws(
    "plugin: MATLAB workspace guard refuses external project path",
    () => guardMatlabWorkspaceArguments({ project_path: PLATFORM }, BUSINESS),
    "outside the active workspace"
  );
  throws(
    "plugin: MATLAB workspace guard refuses parent traversal",
    () => guardMatlabWorkspaceArguments({ script_path: "..\\platform\\script.m" }, BUSINESS),
    "outside the active workspace"
  );

  const indexSource = await fs.readFile(path.join(REPO, "src", "index.ts"), "utf8");
  check("plugin: Core index contains no MATLAB-specific import or symbol",
    !/matlab/i.test(indexSource), indexSource.slice(0, 300));

  console.log(`PLUGIN_FRAMEWORK_OK (${checks} checks)`);
} finally {
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}