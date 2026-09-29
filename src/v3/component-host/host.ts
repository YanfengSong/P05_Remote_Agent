import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CompositionRuntime, type ComponentDefinition, type CompositionDesiredStore } from "../composition/runtime.js";
import { AssetStore } from "../composition/assets.js";
import { CompositionError, keyId } from "../composition/contracts.js";
import { immutableSnapshot } from "../composition/events.js";
import { verifyConfigurationProtection, verifyStateProtection } from "../protection.js";
import { loadOrCreateToken } from "../credentials.js";
import { startRpcServer, type RpcServer } from "../transport/rpc.js";
import { assetQuerySchema, callSchema, componentHostConfigSchema, ComponentHostError, desiredSchema, replaceSchema, type CallableComponentService, type ComponentHostConfig, type InstalledComponentModule } from "./contracts.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw new ComponentHostError(code); }
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
type Installation = ComponentHostConfig["installations"][number];
type SavedDesired = { revision: string; entrypointDigest: string; configVersion: string; config: unknown };

/** Start ONLY in the standalone Optional process. Trusted modules have native Node access;
 * a process boundary protects Core's event loop, not the OS user's files or credentials. */
export async function startComponentHost(configFile: string) {
  const filename = path.resolve(configFile);
  if (!(await verifyStateProtection(path.dirname(filename))).verified || !(await verifyConfigurationProtection(filename)).verified) fail("COMPONENT_CONFIGURATION_UNPROTECTED");
  if (fs.statSync(filename).size > 256 * 1024) fail("COMPONENT_CONFIGURATION_TOO_LARGE");
  const config = componentHostConfigSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
  for (const directory of [config.stateDir, config.installationRoot]) if (!(await verifyStateProtection(directory)).verified) fail("COMPONENT_DIRECTORY_UNPROTECTED");
  config.stateDir = fs.realpathSync(config.stateDir); config.installationRoot = fs.realpathSync(config.installationRoot); config.workspaceRoot = fs.realpathSync(config.workspaceRoot);
  if (!fs.statSync(config.workspaceRoot).isDirectory()) fail("COMPONENT_WORKSPACE_INVALID");
  for (const directory of [config.stateDir, config.installationRoot]) if (inside(config.workspaceRoot, directory) || inside(directory, config.workspaceRoot)) fail("COMPONENT_WORKSPACE_OVERLAP");
  if (inside(config.workspaceRoot, fs.realpathSync(filename))) fail("COMPONENT_WORKSPACE_OVERLAP");
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(config.installations.map((x) => x.installationId)) || !unique(config.components.map((x) => x.componentId)) || !unique(config.capabilities.map((x) => x.capabilityId)) || !unique(config.assets.map((x) => `${x.assetId}/${x.revision}`))) fail("COMPONENT_DUPLICATE_DECLARATION");
  if (config.installations.some((x) => x.manifest.scope !== "workspace")) fail("COMPONENT_HOST_REQUIRES_WORKSPACE_SCOPE");
  const owner = Object.freeze({ slotId: config.slotId, principalId: config.principalId, workspaceRoot: config.workspaceRoot });
  const bindingDigest = hash(JSON.stringify({ owner, capabilities: config.capabilities }));
  const scopeId = "workspace";
  let lock: DatabaseSync | undefined, database: DatabaseSync | undefined, assets: AssetStore | undefined, runtime: CompositionRuntime | undefined, server: RpcServer | undefined;
  let closing: Promise<void> | undefined;
  let accepting = true;
  let configurationOperations = 0;
  const close = () => closing ??= (async () => {
    accepting = false;
    try { await server?.close(); if (runtime && !await runtime.close()) fail("COMPONENT_HOST_DRAIN_INCOMPLETE"); }
    finally { try { assets?.close(); database?.close(); } finally { lock?.close(); } }
  })();

  try {
    const previousMask = process.umask(0o077);
    let client!: ReturnType<typeof loadOrCreateToken>, operator!: ReturnType<typeof loadOrCreateToken>;
    try {
      for (const base of ["owner.sqlite", "components.sqlite"]) for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const file = path.join(config.stateDir, base + suffix);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail("COMPONENT_STATE_SYMLINK");
      }
      lock = new DatabaseSync(path.join(config.stateDir, "owner.sqlite"));
      try { lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS ownership (id INTEGER); BEGIN EXCLUSIVE;"); }
      catch { fail("COMPONENT_HOST_ALREADY_OWNED"); }
      database = new DatabaseSync(path.join(config.stateDir, "components.sqlite"));
      database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);");
      const encodedOwner = JSON.stringify(owner);
      const prior = database.prepare("SELECT value FROM settings WHERE key='owner'").get() as { value: string } | undefined;
      if (prior && prior.value !== encodedOwner) fail("COMPONENT_OWNER_BINDING_CHANGED");
      database.prepare("INSERT OR IGNORE INTO settings VALUES ('owner',?)").run(encodedOwner);
      client = loadOrCreateToken(config.stateDir, "client"); operator = loadOrCreateToken(config.stateDir, "operator");
      assets = new AssetStore(path.join(config.stateDir, "assets"), (asset, evidenceRef) => config.assets.some((item) => item.assetId === asset.assetId && item.revision === asset.revision && item.digest === asset.contentDigest && item.evidenceRef === evidenceRef && item.operatorReviewed));
    } finally { process.umask(previousMask); }
    if (client.token === operator.token || !(await verifyStateProtection(config.stateDir)).verified) fail("COMPONENT_CREATED_STATE_UNPROTECTED");
    const db = database;
    const desiredStore: CompositionDesiredStore = {
      get<T>(key: string): T | undefined { const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; },
      put(key: string, value: unknown) { if (!key.startsWith("service:composition:")) fail("COMPONENT_STATE_NAMESPACE_DENIED"); db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); },
    };
    runtime = new CompositionRuntime({ desiredStore }); // No external gateway: E2+ always rejected.
    const composition = runtime;
    composition.createScope({ id: "platform", kind: "platform" }); composition.createScope({ id: scopeId, kind: "workspace", parentId: "platform" });
    const validatedBytes = (file: string, expectedDigest: string, limit = 1024 * 1024): Buffer => {
      if (fs.lstatSync(file).isSymbolicLink()) fail("COMPONENT_INSTALLATION_SYMLINK");
      const canonical = fs.realpathSync(file);
      if (!inside(config.installationRoot, canonical) || inside(config.workspaceRoot, canonical)) fail("COMPONENT_INSTALLATION_PATH_DENIED");
      const info = fs.statSync(canonical);
      if (!info.isFile() || info.size > limit) fail("COMPONENT_INSTALLATION_SIZE_LIMIT");
      const bytes = fs.readFileSync(canonical);
      if (bytes.length > limit || hash(bytes) !== expectedDigest) fail("COMPONENT_INSTALLATION_DIGEST_MISMATCH");
      return bytes;
    };
    // Verify every catalog entry, including inactive revisions, before accepting requests.
    for (const installation of config.installations) validatedBytes(installation.file, installation.manifest.entrypointDigest);
    const definitions = new Map<string, ComponentDefinition>();
    const load = async (installation: Installation): Promise<ComponentDefinition> => {
      if (!(await verifyConfigurationProtection(installation.file)).verified) fail("COMPONENT_INSTALLATION_UNPROTECTED");
      const bytes = validatedBytes(installation.file, installation.manifest.entrypointDigest);
      const cached = definitions.get(installation.installationId); if (cached) return cached;
      // Execute the exact verified bytes. Relative imports are deliberately unsupported;
      // install a bundled single-file module. Trusted code can still import Node builtins.
      const loaded = await import(`data:text/javascript;base64,${bytes.toString("base64")}`) as Partial<InstalledComponentModule>;
      if (typeof loaded.createComponent !== "function") fail("COMPONENT_FACTORY_REQUIRED");
      const definition = loaded.createComponent({ z });
      if (!definition || !(definition.configSchema instanceof z.ZodType) || typeof definition.activate !== "function") fail("COMPONENT_DEFINITION_INVALID");
      const result = { manifest: installation.manifest, configSchema: definition.configSchema, activate: definition.activate };
      definitions.set(installation.installationId, result); return result;
    };
    const declaredInstallation = (componentId: string, installationId: string) => {
      const installation = config.installations.find((item) => item.installationId === installationId && item.manifest.componentId === componentId);
      if (!installation || !config.components.some((item) => item.componentId === componentId)) return fail("COMPONENT_INSTALLATION_NOT_DECLARED");
      for (const capability of config.capabilities.filter((item) => item.componentId === componentId)) {
        if (!installation.manifest.provides.some((provided) => provided.kind === "single" && keyId(provided.key) === keyId(capability.key))) fail("COMPONENT_CAPABILITY_BINDING_MISMATCH");
        if (capability.effect === "E1" && !installation.manifest.effectOwnership.some((effect) => effect.effect === "E1")) fail("COMPONENT_CAPABILITY_EFFECT_UNDECLARED");
      }
      return installation;
    };
    for (const capability of config.capabilities) if (!config.components.some((item) => item.componentId === capability.componentId)) fail("COMPONENT_CAPABILITY_OWNER_MISSING");
    for (const component of config.components) {
      const saved = desiredStore.get<SavedDesired>(`service:composition:${scopeId}/${component.componentId}`);
      let installationId = component.installationId;
      if (saved) {
        const installed = config.installations.find((item) => item.manifest.componentId === component.componentId && item.manifest.revision === saved.revision && item.manifest.entrypointDigest === saved.entrypointDigest && item.manifest.configVersion === saved.configVersion);
        if (!installed) fail("COMPONENT_PERSISTED_INSTALLATION_UNAVAILABLE");
        installationId = installed.installationId;
      }
      const installation = declaredInstallation(component.componentId, installationId);
      const definition = await load(installation);
      composition.register(scopeId, definition, saved ? saved.config : component.config);
    }
    for (const item of config.assets) {
      const bytes = validatedBytes(item.file, item.digest, 8 * 1024 * 1024);
      let record;
      try { record = assets.getAsset(item.assetId, item.revision); }
      catch (error) { if (!(error instanceof CompositionError) || error.code !== "UNKNOWN_ASSET_REVISION") throw error; }
      if (!record) record = assets.createDraft({ assetId: item.assetId, revision: item.revision, source: "private-operator-installation", author: owner.principalId, effects: item.effects }, bytes);
      if (record.contentDigest !== item.digest) fail("COMPONENT_ASSET_INSTALLATION_CHANGED");
      if (record.state === "DRAFT") await assets.verify(item.assetId, item.revision, item.digest, item.evidenceRef);
    }
    await composition.reconcile();
    const capabilities = Object.freeze(config.capabilities.map((item) => Object.freeze({ ...item, key: Object.freeze({ ...item.key }) })));
    const metadata = { schemaVersion: "p05.component-host.v1", ...owner, bindingDigest, capabilities, securityMode: "trusted-local-plugin", isolationEnforced: false, externalGatewayAvailable: false };
    server = await startRpcServer({ port: config.port, clientToken: client.token, operatorToken: operator.token, maxConcurrent: 32,
      handle: async (method, input, role) => {
        try {
          if (!accepting) fail("COMPONENT_HOST_CLOSING");
          if (["component_replace", "component_desired", "component_drain", "asset_activate"].includes(method) && role !== "operator") fail("COMPONENT_OPERATOR_REQUIRED");
          if (method === "component_status") {
            z.object({}).strict().parse(input);
            const components = config.components.map((item) => composition.status(scopeId, item.componentId));
            return { ...metadata, capabilities: capabilities.map((capability) => ({ ...capability, bindingId: components.find((component) => component.componentId === capability.componentId)?.fibers.find((fiber) => fiber.state === "ACTIVE")?.bindingId ?? null })), components };
          }
          if (method === "component_call") {
            const value = callSchema.parse(input); const capability = capabilities.find((item) => item.capabilityId === value.capabilityId);
            if (!capability) fail("COMPONENT_CAPABILITY_DENIED");
            const pin = composition.pin<CallableComponentService>(scopeId, capability.key);
            try {
              if (value.expectedBindingId !== undefined && value.expectedBindingId !== pin.bindingId) fail("BINDING_CHANGED");
              if (!(pin.value?.inputSchema instanceof z.ZodType) || typeof pin.value.invoke !== "function") fail("COMPONENT_CALLABLE_SERVICE_INVALID");
              const parsed = immutableSnapshot(pin.value.inputSchema.parse(value.input));
              const context = immutableSnapshot({ ...owner, capabilityId: capability.capabilityId, effect: capability.effect, ...(value.runId ? { runId: value.runId } : {}) });
              const result = await pin.value.invoke(parsed, context);
              return { capabilityId: capability.capabilityId, effect: capability.effect, bindingId: pin.bindingId, bindingDigest, result: structuredClone(result) };
            } finally { pin.release(); }
          }
          if (method === "component_replace") {
            if (++configurationOperations > 256) fail("COMPONENT_HOST_RESTART_REQUIRED");
            const value = replaceSchema.parse(input); const installed = declaredInstallation(value.componentId, value.installationId);
            return await composition.replace(scopeId, value.componentId, await load(installed), value.config, value.expectedRevision);
          }
          if (method === "component_desired") {
            if (++configurationOperations > 256) fail("COMPONENT_HOST_RESTART_REQUIRED");
            const value = desiredSchema.parse(input);
            const revision = composition.setDesired(scopeId, value.componentId, { enabled: value.enabled, manualHold: value.manualHold }, value.expectedRevision);
            await composition.reconcile(); return { revision, status: composition.status(scopeId, value.componentId) };
          }
          if (method === "component_drain") {
            const value = z.object({ bindingId: z.string().uuid(), timeoutMs: z.number().int().min(0).max(5_000).default(1_000) }).strict().parse(input);
            return { drained: await composition.waitForDrain(value.bindingId, value.timeoutMs) };
          }
          if (method === "asset_activate") {
            const value = assetQuerySchema.parse(input);
            if (!config.assets.some((item) => item.assetId === value.assetId && item.revision === value.revision && item.digest === value.expectedDigest)) fail("COMPONENT_ASSET_NOT_DECLARED");
            return assets!.activate(value.assetId, value.revision, value.expectedDigest);
          }
          fail("UNKNOWN_COMPONENT_METHOD");
        } catch (error) { return { error: { code: error instanceof ComponentHostError || error instanceof CompositionError ? error.code : error instanceof z.ZodError ? "INVALID_COMPONENT_ARGUMENT" : "COMPONENT_OPERATION_FAILED" } }; }
      },
    });
    const pointer = { ...metadata, endpoint: server.url, clientTokenFile: client.file, operatorTokenFile: operator.file };
    fs.writeFileSync(path.join(config.stateDir, "component-host.json"), JSON.stringify(pointer, null, 2), { mode: 0o600 });
    return { ...pointer, close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
