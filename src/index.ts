import { McpServer } from "@modelcontextprotocol/server";
import { AgentRuntime } from "./agent/runtime.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuditStore } from "./audit/store.js";
import { CAPABILITIES, CapabilityCatalog } from "./capability/registry.js";
import { config, readOwnEnv } from "./config.js";
import { DownstreamRegistry } from "./downstream/registry.js";
import { registerGatewayTools } from "./gateway-tools.js";
import { WorkspaceIsolationManager } from "./isolation/manager.js";
import { PluginRegistry } from "./plugin/registry.js";
import { PluginRuntime } from "./plugin/runtime.js";
import { ProcessRuntime } from "./process/runtime.js";
import { LocalPowerShellDriver } from "./process/drivers/local-powershell.js";
import { SearchRuntime } from "./search/runtime.js";
import { createExposer, logExposure } from "./policy/expose.js";
import { resolveToolProfile } from "./policy/tool-profile.js";
import { BUILTIN_PLUGINS } from "./plugins/builtins.js";
import { createExecutionContext } from "./runtime/context.js";
import { currentExecutionId, ExecutionRuntime } from "./runtime/execution.js";
import { SessionManager } from "./session/manager.js";
import { p05StatePath } from "./state.js";
import { registerAgentTools } from "./tools/register-agent.js";
import { registerControlTools } from "./tools/register-control.js";
import { registerExecutionTools } from "./tools/register-execution.js";
import { registerFsTools } from "./tools/register-fs.js";
import { registerGitTools } from "./tools/register-git.js";
import { registerProcessTools } from "./tools/register-process.js";
import { registerSearchTools } from "./tools/register-search.js";
import { registerTemporaryTools } from "./tools/register-temporary.js";
import { registerDeviceTools } from "./tools/device.js";
import { WorkspaceManager, parseWorkspaceRegistry } from "./workspace/manager.js";

const { profile, profileSource } = resolveToolProfile(readOwnEnv("P05_TOOL_PROFILE"));

let activeDownstreamRegistry: DownstreamRegistry | undefined;
let activePluginRuntime: PluginRuntime | undefined;
let activeProcessRuntime: ProcessRuntime | undefined;
let activeSearchRuntime: SearchRuntime | undefined;
let activeAgentRuntime: AgentRuntime | undefined;

async function closeRuntime(): Promise<void> {
  await activeAgentRuntime?.interruptAll();
  await activeProcessRuntime?.interruptAll();
  activeSearchRuntime?.interruptAll();
  await Promise.all([
    activeDownstreamRegistry?.closeAll(),
    activePluginRuntime?.stopAll()
  ]);
}

process.once("SIGINT", () => void closeRuntime().finally(() => process.exit(0)));
process.once("SIGTERM", () => void closeRuntime().finally(() => process.exit(0)));

serveStdio(() => {
  const server = new McpServer({ name: config.name, version: config.version });

  const workspaceManager = new WorkspaceManager(
    parseWorkspaceRegistry(
      readOwnEnv("P05_WORKSPACES_JSON"),
      config.allowedRoots,
      config.defaultCwd
    ),
    readOwnEnv("P05_ACTIVE_WORKSPACE_ID")
  );

  const pluginRegistry = new PluginRegistry(BUILTIN_PLUGINS);
  const pluginRuntime = new PluginRuntime(pluginRegistry, workspaceManager);
  activePluginRuntime = pluginRuntime;
  void pluginRuntime.startAll();

  const capabilityCatalog = new CapabilityCatalog(CAPABILITIES);
  capabilityCatalog.registerMany(pluginRegistry.capabilities(), "application plugins");

  const downstreamRegistry = new DownstreamRegistry(
    pluginRegistry.downstreamDefinitions(),
    () => ({
      active: { id: workspaceManager.current().id, root: workspaceManager.currentRoot() },
      platform: { id: workspaceManager.platform().id, root: workspaceManager.platformRoot() }
    }),
    (definition) => pluginRuntime.downstreamAllowed(definition)
  );
  activeDownstreamRegistry = downstreamRegistry;

  const auditStore = new AuditStore(200, p05StatePath("audit.json"));
  const sessionManager = new SessionManager(p05StatePath("sessions.json"));
  const processDriver = new LocalPowerShellDriver();
  const processRuntime = new ProcessRuntime(
    sessionManager,
    processDriver,
    () => createExecutionContext({
      workspace: workspaceManager.current(),
      actor: { type: "interactive", id: "mcp-session" },
      profile,
      executionId: currentExecutionId()
    })
  );
  activeProcessRuntime = processRuntime;

  const isolationManager = new WorkspaceIsolationManager({
    statePath: p05StatePath("isolations.json"),
    isolationRoot: readOwnEnv("P05_ISOLATION_ROOT"),
    allowedRoots: config.allowedRoots,
    workspaceRoots: () => workspaceManager.all().map((workspace) => workspace.root)
  });

  const agentRuntime = new AgentRuntime({
    sessions: sessionManager,
    processRuntime,
    isolation: isolationManager,
    pluginRegistry,
    pluginRuntime,
    workspaceManager,
    profile
  });
  activeAgentRuntime = agentRuntime;

  const searchRuntime = new SearchRuntime(
    p05StatePath("search-sessions.json"),
    () => ({
      id: workspaceManager.current().id,
      root: workspaceManager.currentRoot()
    })
  );
  activeSearchRuntime = searchRuntime;

  const executionRuntime = new ExecutionRuntime(auditStore, () => workspaceManager.current().id, capabilityCatalog);
  const exposer = createExposer(
    server,
    profile,
    profileSource,
    executionRuntime,
    capabilityCatalog
  );

  registerDeviceTools(exposer);
  registerControlTools(exposer, workspaceManager, auditStore, pluginRuntime);
  registerAgentTools(exposer, agentRuntime);
  registerFsTools(exposer, workspaceManager);
  registerGitTools(exposer, workspaceManager);
  registerProcessTools(exposer, processRuntime);
  registerSearchTools(exposer, searchRuntime);
  registerExecutionTools(exposer, workspaceManager);
  registerGatewayTools(exposer, downstreamRegistry);
  registerTemporaryTools(exposer);
  pluginRuntime.registerTools(exposer);

  logExposure(exposer.report());
  return server;
});