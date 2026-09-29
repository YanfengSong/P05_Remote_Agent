import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuditStore } from "./audit/store.js";
import { CAPABILITIES, CapabilityCatalog } from "./capability/registry.js";
import { config, readOwnEnv } from "./config.js";
import { DownstreamRegistry } from "./downstream/registry.js";
import { LiveActivityStore } from "./monitor/live-activity.js";
import { ReferenceManager } from "./reference/manager.js";
import { registerGatewayTools } from "./gateway-tools.js";
import {
  startLocalControlBridge,
  type LocalControlBridge
} from "./operator/bridge.js";
import { PluginRegistry } from "./plugin/registry.js";
import { PluginRuntime } from "./plugin/runtime.js";
import { createExposer, logExposure } from "./policy/expose.js";
import { resolveToolProfile } from "./policy/tool-profile.js";
import { ToolPermissionBroker } from "./policy/permission-broker.js";
import { BUILTIN_PLUGINS } from "./plugins/builtins.js";
import { ExecutionRuntime } from "./runtime/execution.js";
import { p05StateDir, p05StatePath } from "./state.js";
import { registerControlTools } from "./tools/register-control.js";
import { registerExecutionTools } from "./tools/register-execution.js";
import { registerFsTools } from "./tools/register-fs.js";
import { registerGitTools } from "./tools/register-git.js";
import { registerReferenceTools } from "./tools/register-reference.js";
import { registerDeviceTools } from "./tools/device.js";
import {
  WorkspaceManager,
  parseWorkspaceRegistry
} from "./workspace/manager.js";
import {
  loadPersistentWorkspaceEntries,
  mergePersistentWorkspaces,
  savePersistentWorkspaceEntries,
  toPersistentWorkspaceEntry,
  type PersistentWorkspaceEntry
} from "./workspace/persistence.js";

const { profile, profileSource } = resolveToolProfile(
  readOwnEnv("P05_TOOL_PROFILE")
);

const runtimeSlotValue = readOwnEnv("P05_RUNTIME_SLOT")?.trim().toUpperCase();
const runtimeSlot =
  runtimeSlotValue === "A" || runtimeSlotValue === "B"
    ? runtimeSlotValue
    : undefined;

let activeDownstreamRegistry: DownstreamRegistry | undefined;
let activePluginRuntime: PluginRuntime | undefined;
let activeLocalControlBridge: LocalControlBridge | undefined;

async function closeRuntime(): Promise<void> {
  await Promise.all([
    activeLocalControlBridge?.close(),
    activeDownstreamRegistry?.closeAll(),
    activePluginRuntime?.stopAll()
  ]);
}

process.once(
  "SIGINT",
  () => void closeRuntime().finally(() => process.exit(0))
);
process.once(
  "SIGTERM",
  () => void closeRuntime().finally(() => process.exit(0))
);

serveStdio(() => {
  const server = new McpServer({
    name: config.name,
    version: config.version
  });

  const configuredWorkspaces = parseWorkspaceRegistry(
    readOwnEnv("P05_WORKSPACES_JSON"),
    config.allowedRoots,
    config.defaultCwd
  );
  const persistentWorkspacePath = p05StatePath("workspaces.json");
  let persistentWorkspaceEntries: PersistentWorkspaceEntry[] =
    loadPersistentWorkspaceEntries(persistentWorkspacePath);
  const workspaceManager = new WorkspaceManager(
    mergePersistentWorkspaces(
      configuredWorkspaces,
      persistentWorkspaceEntries,
      config.allowedRoots,
      config.defaultCwd
    ),
    readOwnEnv("P05_ACTIVE_WORKSPACE_ID")
  );
  const referenceManager = new ReferenceManager(
    p05StatePath("references.json")
  );

  const persistWorkspace = (workspace: Parameters<typeof toPersistentWorkspaceEntry>[0]): void => {
    const nextEntries = [
      ...persistentWorkspaceEntries,
      toPersistentWorkspaceEntry(workspace)
    ];
    mergePersistentWorkspaces(
      configuredWorkspaces,
      nextEntries,
      config.allowedRoots,
      config.defaultCwd
    );
    savePersistentWorkspaceEntries(persistentWorkspacePath, nextEntries);
    persistentWorkspaceEntries = nextEntries;
  };

  const pluginRegistry = new PluginRegistry(BUILTIN_PLUGINS);
  const pluginRuntime = new PluginRuntime(
    pluginRegistry,
    workspaceManager
  );
  activePluginRuntime = pluginRuntime;
  void pluginRuntime.startAll();

  const capabilityCatalog = new CapabilityCatalog(CAPABILITIES);
  capabilityCatalog.registerMany(
    pluginRegistry.capabilities(),
    "application plugins"
  );

  const downstreamRegistry = new DownstreamRegistry(
    pluginRegistry.downstreamDefinitions(),
    () => ({
      active: {
        id: workspaceManager.current().id,
        root: workspaceManager.currentRoot()
      },
      platform: {
        id: workspaceManager.platform().id,
        root: workspaceManager.platformRoot()
      }
    }),
    (definition) => pluginRuntime.downstreamAllowed(definition)
  );
  activeDownstreamRegistry = downstreamRegistry;

  const auditStore = new AuditStore(
    200,
    p05StatePath("audit.json")
  );
  const liveActivity = new LiveActivityStore(300);
  const executionRuntime = new ExecutionRuntime(
    auditStore,
    () => workspaceManager.current().id,
    capabilityCatalog,
    liveActivity,
    {
      source: "runtime-mcp",
      transport: "stdio",
      ...(runtimeSlot ? { runtimeSlot } : {})
    }
  );
  const permissionBroker = new ToolPermissionBroker({
    stateDir: p05StateDir(),
    runtimeSlot,
    workspaceManager,
    capabilityCatalog
  });
  const exposer = createExposer(
    server,
    profile,
    profileSource,
    executionRuntime,
    capabilityCatalog,
    permissionBroker
  );

  registerDeviceTools(exposer);
  registerControlTools(
    exposer,
    workspaceManager,
    auditStore,
    pluginRuntime
  );
  registerFsTools(exposer, workspaceManager);
  registerReferenceTools(exposer, referenceManager);
  registerGitTools(exposer, workspaceManager);
  registerExecutionTools(exposer, workspaceManager);
  registerGatewayTools(exposer, downstreamRegistry);
  pluginRuntime.registerTools(exposer, downstreamRegistry);

  const exposureReport = exposer.report();
  logExposure(exposureReport);

  void startLocalControlBridge({
    workspaceManager,
    referenceManager,
    auditStore,
    pluginRuntime,
    downstreamRegistry,
    capabilityCatalog,
    liveActivity,
    exposure: () => exposer.report(),
    profile,
    profileSource,
    persistWorkspace
  }).then((bridge) => {
    activeLocalControlBridge = bridge;
    process.stderr.write(
      JSON.stringify({
        event: "p05.operator_bridge",
        url: bridge.url
      }) + "\n"
    );
  }).catch((error) => {
    process.stderr.write(
      JSON.stringify({
        event: "p05.operator_bridge_error",
        error: error instanceof Error
          ? error.message
          : String(error)
      }) + "\n"
    );
  });

  return server;
});
