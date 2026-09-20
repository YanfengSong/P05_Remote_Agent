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
import { matlabPlugin } from "../plugins/matlab/plugin.js";
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

  const indexSource = await fs.readFile(path.join(REPO, "src", "index.ts"), "utf8");
  check("plugin: Core index contains no MATLAB-specific import or symbol",
    !/matlab/i.test(indexSource), indexSource.slice(0, 300));

  console.log(`PLUGIN_FRAMEWORK_OK (${checks} checks)`);
} finally {
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}