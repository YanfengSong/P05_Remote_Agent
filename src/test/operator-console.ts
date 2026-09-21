import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "../audit/store.js";
import { CapabilityCatalog } from "../capability/registry.js";
import { DownstreamRegistry } from "../downstream/registry.js";
import { LiveActivityStore, summarizeToolInput } from "../monitor/live-activity.js";
import { startLocalControlBridge } from "../operator/bridge.js";
import { bridgeRequest } from "../operator/runtime-control.js";
import { PluginRegistry } from "../plugin/registry.js";
import { PluginRuntime } from "../plugin/runtime.js";
import type { ToolProfileReport } from "../policy/tool-profile.js";
import { WorkspaceManager, parseWorkspaceRegistry } from "../workspace/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_operator_console_test");
const PLATFORM = path.join(FIXTURE, "platform");
const BUSINESS = path.join(FIXTURE, "business");
const META = path.join(FIXTURE, "bridge.json");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(PLATFORM, { recursive: true });
await fs.mkdir(BUSINESS, { recursive: true });

const workspaces = parseWorkspaceRegistry(
  JSON.stringify([
    { id: "platform", root: PLATFORM, kind: "platform-source" },
    { id: "business", root: BUSINESS, kind: "git-project" }
  ]),
  [FIXTURE],
  PLATFORM
);
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
  const stateDir = path.join(FIXTURE, "state");
  process.env.P05_STATE_DIR = stateDir;
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
  }

  console.log(`OPERATOR_CONSOLE_OK (${checks} checks)`);
} finally {
  await bridge.close();
  await downstreamRegistry.closeAll();
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}

const metadataGone = await fs.access(META).then(() => false).catch(() => true);
check("operator: bridge metadata removed on close", metadataGone);
