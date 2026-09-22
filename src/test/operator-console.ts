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
import { ReferenceManager } from "../reference/manager.js";
import { PLUGIN_API_VERSION, type ApplicationPlugin } from "../plugin/types.js";
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
const OUTSIDE = path.join(path.dirname(FIXTURE), "_p05_operator_outside_workspace");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

const renderedPage = operatorPage("0".repeat(64));
const renderedScript = renderedPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
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
check(
  "operator: obsolete Runtime A-only workspace main view is removed",
  !renderedPage.includes("Runtime A Workspace · 主视图") &&
    renderedPage.includes('<section class="card span12">\n    <h2>Runtime / Host</h2>')
);

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
  liveActivity: [
    {
      id: "live-a",
      capability: "fs_read",
      risk: "read",
      scope: "workspace",
      workspaceId: "platform",
      runtimeSlot: "A",
      source: "runtime-mcp",
      transport: "stdio",
      clientName: "client-a",
      summary: "Read file",
      state: "succeeded",
      phase: "complete",
      startedAt: "2026-09-21T00:00:02.000Z",
      durationMs: 12
    },
    {
      id: "live-b",
      capability: "git_status",
      risk: "read",
      scope: "workspace",
      workspaceId: "business",
      runtimeSlot: "B",
      source: "runtime-mcp",
      transport: "stdio",
      summary: "Git status",
      state: "succeeded",
      phase: "complete",
      startedAt: "2026-09-21T00:00:01.000Z",
      durationMs: 8
    }
  ],
  activity: [
    {
      id: "audit-a",
      capability: "fs_read",
      scope: "workspace",
      workspaceId: "platform",
      runtimeSlot: "A",
      source: "runtime-mcp",
      transport: "stdio",
      clientName: "client-a",
      state: "succeeded",
      phase: "complete",
      startedAt: "2026-09-21T00:00:02.000Z",
      recoveryHint: "none",
      durationMs: 12
    },
    {
      id: "audit-b",
      capability: "git_status",
      scope: "workspace",
      workspaceId: "business",
      runtimeSlot: "B",
      source: "runtime-mcp",
      transport: "stdio",
      state: "succeeded",
      phase: "complete",
      startedAt: "2026-09-21T00:00:01.000Z",
      recoveryHint: "none",
      durationMs: 8
    }
  ],
  recovery: [],
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
        plugins: [],
        downstream: [{
          id: "matlab",
          label: "MathWorks MATLAB MCP Server",
          pluginId: "matlab",
          available: true,
          enabled: true,
          configured: true,
          connected: false,
          workspaceBinding: "active",
          boundWorkspaceId: "platform"
        }],
        activity: [], liveActivity: [], recovery: []
      }
    },
    health: { ready: true, live: true, baseUrl: "http://127.0.0.1:1" },
    runtimeTask: { state: "running" },
    restartTask: { exists: true, state: "ready" },
    processes: [{ Role: "MCP Server", ProcessName: "node", Id: 123, StartTime: "/Date(1789973000623)/" }]
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
      },
      references: [{ id: "ref-a", label: "A Reference", root: "C:\\ref-a" }],
      git: {
        available: true,
        branch: "feat/runtime-a",
        dirty: true,
        ahead: 1,
        behind: 0,
        counts: { staged: 1, modified: 2, untracked: 3, conflicted: 0 },
        files: [{ status: " M", path: "a-file.txt" }],
        diffStat: { unstaged: "a-file.txt | 2 +-", staged: "a-stage.txt | 1 +" },
        lastCommit: { hash: "aaaa111", author: "A User", subject: "A commit" }
      },
      plugins: [
        { id: "matlab", label: "MATLAB / Simulink", version: "2.2.0", apiVersion: "1", enabled: true, state: "running", activeForWorkspace: true, capabilityNames: [], downstreamIds: ["matlab"] }
      ],
      downstream: []
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
      },
      git: {
        available: true,
        branch: "main",
        dirty: false,
        ahead: 0,
        behind: 1,
        counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 },
        files: [],
        diffStat: { unstaged: "", staged: "" },
        lastCommit: { hash: "bbbb222", author: "B User", subject: "B commit" }
      },
      plugins: [
        { id: "matlab", label: "MATLAB / Simulink", version: "2.2.0", apiVersion: "1", enabled: true, state: "stopped", activeForWorkspace: false, capabilityNames: [], downstreamIds: ["matlab"] }
      ],
      downstream: []
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
          : requestPath.endsWith("/reference/pick")
            ? { selected: true, path: "C:\\picked-reference" }
            : {}
    };
  },
  setInterval: () => 0,
  setTimeout: () => 0,
  confirm: () => true,
  console
});
new vm.Script(renderedScript + "\n;globalThis.__p05Render=render;globalThis.__p05PluginControl=pluginControl;globalThis.__p05ReferenceRemove=referenceRemove;").runInContext(browserContext);
(browserContext as any).__p05Render(renderFixture);
check(
  "operator: process time never renders Invalid Date",
  !domElement("processRows").innerHTML.includes("Invalid Date") &&
    domElement("processRows").innerHTML.includes(">-" + "</span>")
);

check(
  "operator: top status cards show isolated Runtime A/B context",
  domElement("topAState").innerHTML.includes("ONLINE") &&
  domElement("topAWorkspace").textContent === "A Workspace" &&
  domElement("topAGit").textContent.includes("feat/runtime-a") &&
  domElement("topAGit").textContent.includes("有未提交修改") &&
  domElement("topBState").innerHTML.includes("ONLINE") &&
  domElement("topBWorkspace").textContent === "B Workspace" &&
  domElement("topBGit").textContent.includes("main") &&
  domElement("topBGit").textContent.includes("clean")
);
check(
  "operator: detailed Git panels render Runtime A and B independently",
  domElement("gitASummary").innerHTML.includes("feat/runtime-a") &&
  domElement("gitAFiles").innerHTML.includes("a-file.txt") &&
  domElement("gitADiffStat").textContent.includes("a-file.txt") &&
  domElement("gitACommit").textContent.includes("aaaa111") &&
  domElement("gitBSummary").innerHTML.includes("main") &&
  domElement("gitBFiles").innerHTML.includes("工作区 clean") &&
  domElement("gitBDiffStat").textContent.includes("UNSTAGED") &&
  domElement("gitBCommit").textContent.includes("bbbb222")
);

check(
  "operator: activity UI identifies Runtime A and B sources",
  domElement("liveRows").innerHTML.includes(">A</span>") &&
  domElement("liveRows").innerHTML.includes("client-a") &&
  domElement("liveRows").innerHTML.includes(">B</span>") &&
  domElement("auditRows").innerHTML.includes(">A</span>") &&
  domElement("auditRows").innerHTML.includes(">B</span>")
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
check(
  "operator: Runtime A renders read-only reference roots",
  domElement("slotAReferenceList").innerHTML.includes("A Reference") &&
  domElement("slotAReferenceList").innerHTML.includes("C:\\ref-a")
);

check(
  "operator: lazy downstream is rendered as READY with auto-connect hint",
  domElement("downstreamRows").innerHTML.includes("READY") &&
  domElement("downstreamRows").innerHTML.includes("首次调用时自动连接") &&
  !domElement("downstreamRows").innerHTML.includes(">configured<")
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
renderFixture.slots.A.git.branch = "feat/refreshed";
await domElement("refresh").onclick();
check(
  "operator: refresh fetches status and rerenders",
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET") &&
  domElement("topAGit").textContent.includes("feat/refreshed")
);

browserRequests.length = 0;
await domElement("slotAToggle").onclick();
check(
  "operator: Runtime A toggle posts slot-scoped disconnect and refreshes",
  browserRequests.some((item) => item.path === "/api/slot/A/action/disconnect" && item.method === "POST") &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

browserRequests.length = 0;
await (browserContext as any).__p05PluginControl("A", "matlab", "stop");
check(
  "operator: plugin stop uses Runtime A scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/A/plugin/matlab/action/stop" &&
    item.method === "POST"
  ) &&
  browserRequests.some((item) => item.path === "/api/status" && item.method === "GET")
);

browserRequests.length = 0;
await (browserContext as any).__p05PluginControl("B", "matlab", "start");
check(
  "operator: plugin start uses Runtime B scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/B/plugin/matlab/action/start" &&
    item.method === "POST"
  )
);

browserRequests.length = 0;
await domElement("slotBPickReference").onclick();
check(
  "operator: Runtime B reference picker uses slot-scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/B/reference/pick" &&
    item.method === "POST"
  ) &&
  domElement("slotBReferenceInput").value === "C:\\picked-reference"
);

browserRequests.length = 0;
domElement("slotBReferenceInput").value = "C:\\reference";
await domElement("slotBAddReference").onclick();
check(
  "operator: Runtime B reference add uses slot-scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/B/reference/root" &&
    item.method === "POST" &&
    item.body === JSON.stringify({ root: "C:\\reference" })
  )
);

browserRequests.length = 0;
await (browserContext as any).__p05ReferenceRemove("A", "ref-a");
check(
  "operator: reference remove uses Runtime A scoped endpoint",
  browserRequests.some((item) =>
    item.path === "/api/slot/A/reference/ref-a/remove" &&
    item.method === "POST"
  )
);

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(PLATFORM, { recursive: true });
await fs.mkdir(BUSINESS, { recursive: true });
await fs.mkdir(SELECTED, { recursive: true });
await fs.rm(OUTSIDE, { recursive: true, force: true });
await fs.mkdir(OUTSIDE, { recursive: true });
await fs.writeFile(path.join(SELECTED, "selected.txt"), "selected\n", "utf8");
await fs.writeFile(path.join(OUTSIDE, "outside.txt"), "outside\n", "utf8");

const workspaces = parseWorkspaceRegistry(
  JSON.stringify([
    { id: "platform", root: PLATFORM, kind: "platform-source" },
    { id: "business", root: BUSINESS, kind: "git-project" }
  ]),
  [FIXTURE],
  PLATFORM
);
savePersistentWorkspaceEntries(PERSISTENT, [
  { id: "selected", root: OUTSIDE, kind: "generic", label: "Selected" }
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
  mergedWorkspaces.some((item) => item.id === "selected" && item.root === OUTSIDE) &&
  mergedWorkspaces.length === 3
);
await fs.rm(PERSISTENT, { force: true });

const workspaceManager = new WorkspaceManager(workspaces, "platform");
const referenceManager = new ReferenceManager(path.join(FIXTURE, "references.json"));
let operatorPluginStarts = 0;
let operatorPluginStops = 0;
const operatorPlugin: ApplicationPlugin = {
  manifest: {
    id: "operator-test",
    label: "Operator Test Plugin",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: true,
    capabilities: [],
    permissions: { workspace: "active", hostEffects: "none" }
  },
  start: () => { operatorPluginStarts += 1; },
  stop: () => { operatorPluginStops += 1; }
};
const pluginRegistry = new PluginRegistry([operatorPlugin]);
const pluginRuntime = new PluginRuntime(pluginRegistry, workspaceManager);
await pluginRuntime.startAll();
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
  referenceManager,
  auditStore,
  pluginRuntime,
  downstreamRegistry,
  capabilityCatalog,
  liveActivity,
  exposure: () => exposure,
  profile: "developer",
  profileSource: "env",
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

  const pluginStop = await fetch(metadata.url + "/api/plugin/operator-test/action/stop", {
    method: "POST",
    headers: authHeaders,
    body: "{}"
  });
  check("operator: bridge plugin stop endpoint succeeds", pluginStop.status === 200, String(pluginStop.status));
  check(
    "operator: bridge plugin stop changes runtime state",
    pluginRuntime.list()[0]?.state === "stopped" && operatorPluginStops === 1,
    JSON.stringify(pluginRuntime.list())
  );
  const pluginStart = await fetch(metadata.url + "/api/plugin/operator-test/action/start", {
    method: "POST",
    headers: authHeaders,
    body: "{}"
  });
  check("operator: bridge plugin start endpoint succeeds", pluginStart.status === 200, String(pluginStart.status));
  check(
    "operator: bridge plugin start changes runtime state",
    pluginRuntime.list()[0]?.state === "running" && operatorPluginStarts === 2,
    JSON.stringify(pluginRuntime.list())
  );

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

  const referenceDir = path.join(FIXTURE, "reference-docs");
  await fs.mkdir(referenceDir, { recursive: true });
  await fs.writeFile(path.join(referenceDir, "guide.txt"), "guide\n", "utf8");

  const addReference = await fetch(metadata.url + "/api/reference/root", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ root: referenceDir })
  });
  check("operator: bridge reference add endpoint succeeds", addReference.status === 200, String(addReference.status));
  const addedReference = await addReference.json() as { reference?: { id?: string; root?: string } };
  const addedReferenceId = addedReference.reference?.id ?? "";
  check(
    "operator: bridge reference add persists local root",
    Boolean(addedReferenceId) &&
    addedReference.reference?.root === referenceDir &&
    referenceManager.localList().some((item) => item.id === addedReferenceId && item.root === referenceDir)
  );

  const referencesResult = await fetch(metadata.url + "/api/references", {
    headers: authHeaders
  });
  const referencesJson = await referencesResult.json() as {
    references?: Array<{ id: string; root: string }>;
  };
  check(
    "operator: bridge reference list includes local root",
    referencesResult.status === 200 &&
    referencesJson.references?.some((item) => item.id === addedReferenceId && item.root === referenceDir) === true
  );

  const removeReference = await fetch(metadata.url + `/api/reference/${addedReferenceId}/remove`, {
    method: "POST",
    headers: authHeaders,
    body: "{}"
  });
  check(
    "operator: bridge reference remove endpoint succeeds without deleting directory",
    removeReference.status === 200 &&
    !referenceManager.localList().some((item) => item.id === addedReferenceId) &&
    await fs.access(referenceDir).then(() => true).catch(() => false),
    String(removeReference.status)
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
  const outsideRoot = await fetch(metadata.url + "/api/workspace/root", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ root: OUTSIDE })
  });
  check(
    "operator: local folder selection authorizes a Runtime root outside startup allowed roots",
    outsideRoot.status === 200 && workspaceManager.currentRoot() === path.resolve(OUTSIDE),
    String(outsideRoot.status)
  );
  const outsideEntries = await listDirectory(".", workspaceManager.currentRoot());
  check(
    "operator: dynamically selected Runtime root is immediately usable",
    outsideEntries.includes("[FILE] outside.txt")
  );

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
  const operatorRoot = path.join(FIXTURE, "operator-root");
  const stateDir = path.join(operatorRoot, "runtime-a", "state");
  process.env.P05_OPERATOR_ROOT = operatorRoot;
  process.env.P05_STATE_DIR = stateDir;
  await fs.mkdir(stateDir, { recursive: true });
  const fallbackBridge = await startLocalControlBridge({
    workspaceManager,
    referenceManager,
    auditStore,
    pluginRuntime,
    downstreamRegistry,
    capabilityCatalog,
    liveActivity,
    exposure: () => exposure,
    profile: "developer",
    profileSource: "env",
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

    const processRows = statusOverview?.connection?.processes ?? [];
    check(
      "operator: process start times are normalized as parseable ISO timestamps",
      processRows.every((item: any) =>
        !item?.StartTime ||
        (
          typeof item.StartTime === "string" &&
          !item.StartTime.startsWith("/Date(") &&
          Number.isFinite(Date.parse(item.StartTime))
        )
      ),
      JSON.stringify(processRows)
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
  }

  console.log(`OPERATOR_CONSOLE_OK (${checks} checks)`);
} finally {
  await bridge.close();
  await downstreamRegistry.closeAll();
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => undefined);
}

const metadataGone = await fs.access(META).then(() => false).catch(() => true);
check("operator: bridge metadata removed on close", metadataGone);
