import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { AuditStore } from "../audit/store.js";
import { CapabilityCatalog } from "../capability/registry.js";
import { DownstreamRegistry } from "../downstream/registry.js";
import { LiveActivityStore, summarizeToolInput } from "../monitor/live-activity.js";
import { startLocalControlBridge } from "../operator/bridge.js";
import { bridgeRequest, operatorOverview } from "../operator/runtime-control.js";
import { operatorPage } from "../operator/ui.js";
import { PluginRegistry } from "../plugin/registry.js";
import { PluginRuntime } from "../plugin/runtime.js";
import type { ToolProfileReport } from "../policy/tool-profile.js";
import { listDirectory } from "../tools/files.js";
import { WorkspaceManager, parseWorkspaceRegistry } from "../workspace/manager.js";
import {
  loadPersistentWorkspaceEntries,
  mergePersistentWorkspaces,
  savePersistentWorkspaceEntries
} from "../workspace/persistence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_operator_console_test");
const PLATFORM = path.join(FIXTURE, "platform");
const BUSINESS = path.join(FIXTURE, "business");
const SELECTED = path.join(FIXTURE, "selected");
const META = path.join(FIXTURE, "bridge.json");
const PERSISTENT = path.join(FIXTURE, "workspaces.json");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

const renderedScript = operatorPage("0".repeat(64)).match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
let renderedScriptParses = false;
try {
  if (renderedScript) {
    new vm.Script(renderedScript);
    renderedScriptParses = true;
  }
} catch {
  renderedScriptParses = false;
}
check("operator: rendered browser script parses", renderedScriptParses);

const domElements: Record<string, any> = {};
const domElement = (id: string) => domElements[id] ??= {
  innerHTML: "",
  textContent: "",
  className: "",
  disabled: false,
  value: "",
  style: { display: "" }
};
const renderFixture = {
  timestamp: "2026-09-21T00:00:00.000Z",
  connection: {
    connected: true,
    bridge: {
      online: true,
      data: {
        mcp: {
          profile: "developer",
          profileSource: "test",
          exposure: { exposed: ["device_info"], suppressed: [] },
          capabilities: []
        },
        workspace: {
          current: {
            id: "platform",
            label: "Test Workspace",
            root: "C:\\test",
            kind: "platform-source",
            plugins: [],
            authorization: {
              structuredCrossWorkspace: "deny",
              externalPersistentWrite: "approval-required",
              shellBoundary: "trusted-user"
            }
          },
          all: [
            { id: "platform", label: "Test Workspace", root: "C:\\test", kind: "platform-source", current: true, plugins: [] },
            { id: "business", label: "Business Workspace", root: "C:\\business", kind: "git-project", current: false, plugins: [] }
          ]
        },
        device: {
          deviceId: "test-device",
          hostname: "test-host",
          agentVersion: "0.0.0",
          platform: "win32",
          release: "test",
          arch: "x64",
          startedAt: "2026-09-21T00:00:00.000Z"
        },
        plugins: [], downstream: [], activity: [], liveActivity: [], recovery: []
      }
    },
    health: { ready: true, live: true, baseUrl: "http://127.0.0.1:1" },
    runtimeTask: { state: "running" },
    restartTask: { exists: true, state: "ready" },
    processes: [{ Role: "MCP Server", ProcessName: "node", Id: 123, StartTime: "2026-09-21T00:00:00.000Z" }]
  },
  slots: {
    A: {
      id: "A", connector: "@Boonray-A", connected: true,
      boundWorkspaceId: "platform", health: { ready: true, live: true }, bridge: { online: true },
      device: { deviceId: "device-a" },
      workspace: {
        current: { id: "platform", label: "A Workspace", root: "C:\\a", kind: "platform-source" },
        all: [
          { id: "platform", label: "A Workspace", root: "C:\\a", kind: "platform-source", current: true },
          { id: "business", label: "A Business", root: "C:\\a-business", kind: "git-project", current: false }
        ]
      }
    },
    B: {
      id: "B", connector: "@Boonray-B", connected: true,
      boundWorkspaceId: "business", health: { ready: true, live: true }, bridge: { online: true },
      device: { deviceId: "device-b" },
      workspace: {
        current: { id: "business", label: "B Workspace", root: "C:\\b", kind: "git-project" },
        all: [
          { id: "platform", label: "B Platform", root: "C:\\b-platform", kind: "platform-source", current: false },
          { id: "business", label: "B Workspace", root: "C:\\b", kind: "git-project", current: true }
        ]
      }
    }
  },
  git: {
    available: true,
    branch: "feat/test",
    dirty: false,
    ahead: 0,
    behind: 0,
    counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 },
    files: [],
    diffStat: { unstaged: "", staged: "" }
  },
  logTail: [],
  operator: {}
};
const browserRequests: Array<{ path: string; method: string; body?: string }> = [];
const browserContext = vm.createContext({
  document: { getElementById: (id: string) => domElement(id) },
  fetch: async (requestPath: string, options: any = {}) => {
    browserRequests.push({
      path: requestPath,
      method: options.method ?? "GET",
      body: options.body
    });
    return {
      ok: true,
      status: 200,
      json: async () => requestPath === "/api/status"
        ? renderFixture
        : requestPath === "/api/workspace/pick"
          ? { selected: true, path: "C:\\picked" }
          : {}
    };
  },
  setInterval: () => 0,
  setTimeout: () => 0,
  confirm: () => true,
  console
});
new vm.Script(renderedScript + "\n;globalThis.__p05Render=render;").runInContext(browserContext);
(browserContext as any).__p05Render(renderFixture);
check(
  "operator: render updates top status cards",
  domElement("connectionBig").innerHTML.includes("已连接") &&
  domElement("mcpBig").innerHTML.includes("ONLINE") &&
  domElement("workspaceBig").textContent === "Test Workspace" &&
  domElement("gitBig").textContent === "feat/test"
);
check(
  "operator: renders isolated runtime slots",
  domElement("slotADeviceId").textContent === "device-a" &&
  domElement("slotAWorkspace").textContent === "A Workspace" &&
  domElement("slotBDeviceId").textContent === "device-b" &&
  domElement("slotBWorkspace").textContent === "B Workspace" &&
  domElement("slotABoundWorkspace").textContent === "platform" &&
  domElement("slotBBoundWorkspace").textContent === "business"
);

browserRequests.length = 0;
domElement("slotBWorkspaceSelect").value = "platform";
domElement("slotBWorkspaceSelect").onchange();
await domElement("slotBSwitchWorkspace").onclick();
check(
  "operator: Runtime B workspace switch uses slot-scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/B/workspace/select" &&
    item.method === "POST" &&
    item.body === JSON.stringify({ id: "platform" })
  )
);

browserRequests.length = 0;
renderFixture.git.branch = "feat/refreshed";
await domElement("refresh").onclick();
check(
  "operator: refresh fetches status and rerenders",
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET") &&
  domElement("gitBig").textContent === "feat/refreshed"
);

domElement("workspaceSelect").value = "business";
domElement("workspaceSelect").onchange();
(browserContext as any).__p05Render(renderFixture);
check(
  "operator: auto refresh preserves pending workspace selection",
  domElement("workspaceSelect").value === "business"
);

browserRequests.length = 0;
domElement("workspaceSelect").value = "business";
await domElement("switchWorkspace").onclick();
check(
  "operator: workspace switch posts selected id and refreshes",
  browserRequests.some((item) =>
    item.path === "/api/workspace/select" &&
    item.method === "POST" &&
    item.body === JSON.stringify({ id: "business" })
  ) &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

browserRequests.length = 0;
await domElement("pickWorkspaceRoot").onclick();
check(
  "operator: folder picker fills workspace root input",
  browserRequests.some((item) => item.path === "/api/workspace/pick" && item.method === "POST") &&
  domElement("workspaceRootInput").value === "C:\\picked"
);

browserRequests.length = 0;
domElement("workspaceRootInput").value = "C:\\selected";
await domElement("setWorkspaceRoot").onclick();
check(
  "operator: set workspace root posts path and refreshes",
  browserRequests.some((item) =>
    item.path === "/api/workspace/root" &&
    item.method === "POST" &&
    item.body === JSON.stringify({ root: "C:\\selected" })
  ) &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

browserRequests.length = 0;
await domElement("registerWorkspace").onclick();
check(
  "operator: save workspace posts persistent registration",
  browserRequests.some((item) => item.path === "/api/workspace/register" && item.method === "POST") &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

browserRequests.length = 0;
await domElement("slotAToggle").onclick();
check(
  "operator: Runtime A toggle posts slot-scoped disconnect and refreshes",
  browserRequests.some((item) => item.path === "/api/slot/A/action/disconnect" && item.method === "POST") &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(PLATFORM, { recursive: true });
await fs.mkdir(BUSINESS, { recursive: true });
await fs.mkdir(SELECTED, { recursive: true });
await fs.writeFile(path.join(SELECTED, "selected.txt"), "selected\n", "utf8");

const workspaces = parseWorkspaceRegistry(
  JSON.stringify([
    { id: "platform", root: PLATFORM, kind: "platform-source" },
    { id: "business", root: BUSINESS, kind: "git-project" }
  ]),
  [FIXTURE],
  PLATFORM
);
savePersistentWorkspaceEntries(PERSISTENT, [
  { id: "selected", root: SELECTED, kind: "generic", label: "Selected" }
]);
const persistedEntries = loadPersistentWorkspaceEntries(PERSISTENT);
const mergedWorkspaces = mergePersistentWorkspaces(
  workspaces,
  persistedEntries,
  [FIXTURE],
  PLATFORM
);
check(
  "operator: persistent workspace registry survives reload",
  mergedWorkspaces.some((item) => item.id === "selected" && item.root === SELECTED) &&
  mergedWorkspaces.length === 3
);
await fs.rm(PERSISTENT, { force: true });

const workspaceManager = new WorkspaceManager(workspaces, "platform");
const pluginRegistry = new PluginRegistry([]);
const pluginRuntime = new PluginRuntime(pluginRegistry, workspaceManager);
const downstreamRegistry = new DownstreamRegistry(
  [],
  () => ({
    active: {
      id: workspaceManager.current().id,
      root: workspaceManager.currentRoot()
    },
    platform: {
      id: workspaceManager.platform().id,
      root: workspaceManager.platformRoot()
    }
  })
);
const auditStore = new AuditStore(20);
const capabilityCatalog = new CapabilityCatalog();
const liveActivity = new LiveActivityStore(20);
const exposure: ToolProfileReport = {
  profile: "developer",
  profileSource: "env",
  exposed: ["device_info", "workspace_list"],
  suppressed: []
};
const persistedByBridge: string[] = [];

const bridge = await startLocalControlBridge({
  workspaceManager,
  auditStore,
  pluginRuntime,
  downstreamRegistry,
  capabilityCatalog,
  liveActivity,
  exposure: () => exposure,
  profile: "developer",
  profileSource: "env",
  allowedRoots: [FIXTURE],
  persistWorkspace: (workspace) => persistedByBridge.push(workspace.id),
  metadataPath: META,
  port: 0
});

try {
  const metadata = JSON.parse(await fs.readFile(META, "utf8")) as {
    url: string;
    token: string;
    pid: number;
  };
  check("operator: metadata has loopback url", /^http:\/\/127\.0\.0\.1:\d+$/.test(metadata.url), metadata.url);
  check("operator: metadata has random token", /^[a-f0-9]{64}$/.test(metadata.token));
  check("operator: metadata carries pid", metadata.pid === process.pid);

  const denied = await fetch(metadata.url + "/api/overview");
  check("operator: bridge refuses missing token", denied.status === 401, String(denied.status));

  const authHeaders = {
    authorization: `Bearer ${metadata.token}`,
    "content-type": "application/json"
  };
  const overview = await fetch(metadata.url + "/api/overview", {
    headers: authHeaders
  });
  check("operator: authorized overview succeeds", overview.status === 200, String(overview.status));
  const overviewJson = await overview.json() as {
    mcp?: { profile?: string };
    workspace?: {
      current?: { id?: string; root?: string };
      all?: Array<{ id?: string; root?: string }>;
    };
  };
  check("operator: overview reports profile", overviewJson.mcp?.profile === "developer");
  check("operator: overview reports current workspace", overviewJson.workspace?.current?.id === "platform");
  check("operator: local overview includes workspace root", overviewJson.workspace?.current?.root === PLATFORM);
  check("operator: overview lists both workspaces", overviewJson.workspace?.all?.length === 2);

  const switched = await fetch(metadata.url + "/api/workspace/select", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ id: "business" })
  });
  check("operator: workspace switch endpoint succeeds", switched.status === 200, String(switched.status));
  check("operator: workspace switch changes live manager", workspaceManager.current().id === "business");

  const workspacesResult = await fetch(metadata.url + "/api/workspaces", {
    headers: authHeaders
  });
  const workspacesJson = await workspacesResult.json() as {
    workspaces?: Array<{ id: string; root: string; current: boolean }>;
  };
  check("operator: workspace list endpoint succeeds", workspacesResult.status === 200);
  check(
    "operator: workspace list is non-mutating and shows roots",
    workspacesJson.workspaces?.some((item) =>
      item.id === "business" && item.current && item.root === BUSINESS
    ) === true
  );

  const setRoot = await fetch(metadata.url + "/api/workspace/root", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ root: SELECTED })
  });
  check("operator: workspace root endpoint succeeds", setRoot.status === 200, String(setRoot.status));
  check(
    "operator: workspace root changes active MCP scope",
    workspaceManager.current().id === "operator-session" && workspaceManager.currentRoot() === SELECTED
  );
  const selectedEntries = await listDirectory(".", workspaceManager.currentRoot());
  check(
    "operator: filesystem resolves against selected workspace root",
    selectedEntries.includes("[FILE] selected.txt")
  );
  const registered = await fetch(metadata.url + "/api/workspace/register", {
    method: "POST",
    headers: authHeaders,
    body: "{}"
  });
  check("operator: persistent workspace registration succeeds", registered.status === 200, String(registered.status));
  check(
    "operator: persistent registration replaces operator session",
    workspaceManager.current().id === "selected" &&
    !workspaceManager.list().some((item) => item.id === "operator-session") &&
    persistedByBridge.includes("selected")
  );
  const refusedRoot = await fetch(metadata.url + "/api/workspace/root", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ root: path.dirname(FIXTURE) })
  });
  check("operator: workspace root refuses outside allowed roots", refusedRoot.status === 400, String(refusedRoot.status));

  const shellDetail = summarizeToolInput("shell_run", {
    command: "tool --token=super-secret-value --password hunter2"
  }) ?? "";
  check(
    "operator: shell detail redacts token",
    !shellDetail.includes("super-secret-value") && shellDetail.includes("<redacted>"),
    shellDetail
  );
  check(
    "operator: shell detail redacts password",
    !shellDetail.includes("hunter2"),
    shellDetail
  );

  const mcpDetail = summarizeToolInput("mcp_call_tool", {
    server: "matlab",
    tool: "run",
    arguments: { token: "never-show-this" }
  }) ?? "";
  check(
    "operator: downstream arguments are not exposed",
    mcpDetail === "matlab / run",
    mcpDetail
  );

  const previousStateDir = process.env.P05_STATE_DIR;
  const previousOperatorRoot = process.env.P05_OPERATOR_ROOT;
  const previousRuntimeSlots = process.env.P05_RUNTIME_SLOTS;
  const operatorRoot = path.join(FIXTURE, "operator-root");
  const stateDir = path.join(operatorRoot, "runtime-a", "state");
  process.env.P05_OPERATOR_ROOT = operatorRoot;
  process.env.P05_STATE_DIR = stateDir;
  process.env.P05_RUNTIME_SLOTS = "A";
  await fs.mkdir(stateDir, { recursive: true });
  const fallbackBridge = await startLocalControlBridge({
    workspaceManager,
    auditStore,
    pluginRuntime,
    downstreamRegistry,
    capabilityCatalog,
    liveActivity,
    exposure: () => exposure,
    profile: "developer",
    profileSource: "env",
    allowedRoots: [FIXTURE],
    port: 0
  });
  try {
    const pidMetadata = path.join(
      stateDir,
      `operator-bridge-${process.pid}.json`
    );
    const pidMetadataExists = await fs.access(pidMetadata)
      .then(() => true)
      .catch(() => false);
    check(
      "operator: default bridge metadata is pid-scoped",
      pidMetadataExists
    );

    const statusOverview = await operatorOverview() as any;
    const guiData = statusOverview?.connection?.bridge?.data;
    check(
      "operator: single-runtime topology keeps A configured",
      statusOverview?.slots?.A?.configured === true,
      JSON.stringify(statusOverview?.slots?.A)
    );
    check(
      "operator: single-runtime topology reports B as not configured",
      statusOverview?.slots?.B?.configured === false &&
        statusOverview?.slots?.B?.connected === false,
      JSON.stringify(statusOverview?.slots?.B)
    );

    process.env.P05_RUNTIME_SLOTS = "A,B";
    const dualOverview = await operatorOverview() as any;
    check(
      "operator: dual-runtime topology configures both slots",
      dualOverview?.slots?.A?.configured === true &&
        dualOverview?.slots?.B?.configured === true,
      JSON.stringify(dualOverview?.slots)
    );
    process.env.P05_RUNTIME_SLOTS = "A";
    check(
      "operator: status overview satisfies GUI render contract",
      typeof statusOverview?.timestamp === "string" &&
      typeof statusOverview?.connection?.connected === "boolean" &&
      statusOverview?.connection?.bridge?.online === true &&
      Array.isArray(statusOverview?.connection?.processes) &&
      typeof statusOverview?.git === "object" &&
      Array.isArray(statusOverview?.logTail) &&
      typeof guiData?.device?.deviceId === "string" &&
      typeof guiData?.mcp?.profile === "string" &&
      typeof guiData?.mcp?.profileSource === "string" &&
      Array.isArray(guiData?.mcp?.exposure?.exposed) &&
      Array.isArray(guiData?.mcp?.exposure?.suppressed) &&
      Array.isArray(guiData?.mcp?.capabilities) &&
      typeof guiData?.workspace?.current?.id === "string" &&
      Array.isArray(guiData?.workspace?.all) &&
      Array.isArray(guiData?.plugins) &&
      Array.isArray(guiData?.downstream) &&
      Array.isArray(guiData?.activity) &&
      Array.isArray(guiData?.liveActivity) &&
      Array.isArray(guiData?.recovery),
      JSON.stringify(statusOverview)
    );

    await fs.writeFile(
      path.join(stateDir, "operator-bridge.json"),
      JSON.stringify({
        version: 1,
        url: "http://127.0.0.1:9",
        token: "0".repeat(64),
        pid: 2147483647,
        startedAt: new Date().toISOString()
      })
    );

    const fallbackOverview = await bridgeRequest("/api/overview") as {
      online?: boolean;
    };
    check(
      "operator: stale singleton metadata falls back to live pid bridge",
      fallbackOverview.online === true
    );
  } finally {
    await fallbackBridge.close();
    if (previousStateDir === undefined) {
      delete process.env.P05_STATE_DIR;
    } else {
      process.env.P05_STATE_DIR = previousStateDir;
    }
    if (previousOperatorRoot === undefined) {
      delete process.env.P05_OPERATOR_ROOT;
    } else {
      process.env.P05_OPERATOR_ROOT = previousOperatorRoot;
    }
    if (previousRuntimeSlots === undefined) {
      delete process.env.P05_RUNTIME_SLOTS;
    } else {
      process.env.P05_RUNTIME_SLOTS = previousRuntimeSlots;
    }
  }

  console.log(`OPERATOR_CONSOLE_OK (${checks} checks)`);
} finally {
  await bridge.close();
  await downstreamRegistry.closeAll();
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}

const metadataGone = await fs.access(META).then(() => false).catch(() => true);
check("operator: bridge metadata removed on close", metadataGone);
