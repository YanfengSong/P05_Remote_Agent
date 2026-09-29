import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadOrCreateToken } from "../credentials.js";
import { verifyConfigurationProtection, verifyStateProtection } from "../protection.js";
import { startRpcServer, type RpcRole, type RpcServer } from "../transport/rpc.js";
import { ResourceCoordinator } from "./coordinator.js";
import { ResourceError, type LeaseOwner } from "./types.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const configSchema = z.object({
  version: z.literal(1), hostId: id, stateDir: z.string().refine(path.isAbsolute),
  slots: z.array(z.object({ slotId: id, principalId: id, workspaceRoot: z.string().refine(path.isAbsolute), port: z.number().int().min(0).max(65535).default(0) }).strict()).min(1).max(16),
}).strict();
const descriptorSchema = z.object({ resourceId: id, kind: id, stablePhysicalIdentity: z.string().min(1).max(512), mode: z.enum(["shared", "serialized-operation", "exclusive-session"]), capacity: z.number().int().min(1).max(1024), adapter: id }).strict();
const contextSchema = z.object({ contextId: id, runId: id, executorId: id, executorBootId: id, resourceIds: z.array(id).min(1).max(32), expiresAt: z.number().int().positive(), maxLeaseMs: z.number().int().min(1).max(300_000) }).strict();
const contextQuery = z.object({ contextId: id }).strict();
const credentialSchema = z.object({ leaseId: id, fencingEpoch: z.number().int().positive(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const leaseQuery = z.object({ contextId: id, credential: credentialSchema }).strict();
const requestQuery = z.object({ contextId: id, requestId: id }).strict();
type Slot = z.infer<typeof configSchema>["slots"][number];
type Context = z.infer<typeof contextSchema> & { slotId: string; principalId: string; revokedAt: number | null };
type ContextRow = { context_key: string; record: string };

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function contextKey(slot: Slot, contextId: string): string { return JSON.stringify([slot.slotId, contextId]); }
function owner(context: Context): LeaseOwner { return { slotId: context.slotId, runId: context.runId, executorId: context.executorId, executorBootId: context.executorBootId }; }
function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean { return left.slotId === right.slotId && left.runId === right.runId && left.executorId === right.executorId && left.executorBootId === right.executorBootId; }

/** One process owns the Host coordinator. Per-Slot listeners share that instance.
 * Client tokens belong to trusted Slot Core processes, never to Edge/Agent clients. */
export async function startResourceHost(configFile: string) {
  const filename = path.resolve(configFile);
  if (!(await verifyStateProtection(path.dirname(filename))).verified || !(await verifyConfigurationProtection(filename)).verified) throw new Error("RESOURCE_CONFIGURATION_PROTECTION_UNVERIFIED");
  if (fs.statSync(filename).size > 64 * 1024) throw new Error("RESOURCE_CONFIGURATION_TOO_LARGE");
  const config = configSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
  if (new Set(config.slots.map((slot) => slot.slotId)).size !== config.slots.length) throw new Error("DUPLICATE_RESOURCE_SLOT");
  if (!(await verifyStateProtection(config.stateDir)).verified) throw new Error("RESOURCE_STATE_PROTECTION_UNVERIFIED");
  const stateDir = fs.realpathSync(config.stateDir);
  for (const slot of config.slots) {
    slot.workspaceRoot = fs.realpathSync(slot.workspaceRoot);
    if (!fs.statSync(slot.workspaceRoot).isDirectory() || inside(slot.workspaceRoot, stateDir) || inside(stateDir, slot.workspaceRoot)
      || inside(slot.workspaceRoot, fs.realpathSync(filename))) throw new Error("RESOURCE_STATE_WORKSPACE_OVERLAP");
  }

  let coordinator: ResourceCoordinator | undefined;
  let contexts: DatabaseSync | undefined;
  const servers: RpcServer[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintenanceHealthy = true;
  let closing: Promise<void> | undefined;
  const endpoints: { slotId: string; principalId: string; endpoint: string; clientTokenFile: string }[] = [];
  const close = () => closing ??= (async () => {
    if (timer) clearInterval(timer);
    const results = await Promise.allSettled(servers.map((server) => server.close()));
    try { contexts?.close(); } finally { coordinator?.close(); }
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  })();

  try {
    const previousMask = process.umask(0o077);
    let operatorCredential: ReturnType<typeof loadOrCreateToken>;
    const clientCredentials = new Map<string, ReturnType<typeof loadOrCreateToken>>();
    try {
      coordinator = ResourceCoordinator.open({ stateDir, hostId: config.hostId });
      const contextFile = path.join(stateDir, "resource-contexts.sqlite");
      contexts = new DatabaseSync(contextFile);
      contexts.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS slot_bindings (slot_id TEXT PRIMARY KEY, binding TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS contexts (context_key TEXT PRIMARY KEY, slot_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(slot_id,run_id));
        CREATE TABLE IF NOT EXISTS request_bindings (request_id TEXT PRIMARY KEY, context_key TEXT NOT NULL);
      `);
      operatorCredential = loadOrCreateToken(stateDir, "operator");
      for (const slot of config.slots) {
        const binding = JSON.stringify({ slotId: slot.slotId, principalId: slot.principalId, workspaceRoot: slot.workspaceRoot });
        const existing = contexts.prepare("SELECT binding FROM slot_bindings WHERE slot_id=?").get(slot.slotId) as { binding: string } | undefined;
        if (existing && existing.binding !== binding) throw new Error("RESOURCE_SLOT_BINDING_CHANGED");
        contexts.prepare("INSERT OR IGNORE INTO slot_bindings VALUES (?, ?)").run(slot.slotId, binding);
        const credentialDir = path.join(stateDir, `slot-${digest(slot.slotId).slice(0, 24)}`);
        fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
        clientCredentials.set(slot.slotId, loadOrCreateToken(credentialDir, "client"));
      }
      if (new Set([operatorCredential.token, ...[...clientCredentials.values()].map((credential) => credential.token)]).size !== clientCredentials.size + 1) throw new Error("RESOURCE_CREDENTIAL_COLLISION");
    } finally { process.umask(previousMask); }
    if (!(await verifyStateProtection(stateDir)).verified) throw new Error("RESOURCE_CREATED_STATE_PROTECTION_UNVERIFIED");
    const store = contexts;
    const resource = coordinator;

    const getContext = (slot: Slot, contextId: string, active = true): Context => {
      const row = store.prepare("SELECT record FROM contexts WHERE context_key=?").get(contextKey(slot, contextId)) as { record: string } | undefined;
      const context = row ? JSON.parse(row.record) as Context : undefined;
      if (!context || context.slotId !== slot.slotId || context.principalId !== slot.principalId) throw new ResourceError("RESOURCE_CONTEXT_NOT_FOUND");
      if (active && (context.revokedAt !== null || context.expiresAt <= Date.now())) throw new ResourceError("RESOURCE_CONTEXT_INACTIVE");
      return context;
    };

    const quarantineContext = (key: string, context: Context): void => {
      const leaseOwner = owner(context);
      for (const row of store.prepare("SELECT request_id FROM request_bindings WHERE context_key=?").all(key) as { request_id: string }[]) {
        try {
          const request = resource.queryRequest(row.request_id, leaseOwner);
          if (request.state === "WAITING") resource.cancelWait(row.request_id, leaseOwner);
        } catch (error) { if (!(error instanceof ResourceError) || error.code !== "REQUEST_NOT_FOUND_OR_NOT_OWNED") throw error; }
      }
      for (const resourceId of context.resourceIds) {
        const state = resource.inspect(resourceId);
        if (state.holders.some((lease) => sameOwner(lease.owner, leaseOwner) && lease.state === "ACTIVE")) resource.quarantine(resourceId, "RUN_CONTEXT_REVOKED_OR_EXPIRED");
      }
    };

    const maintenance = (): void => {
      for (const row of store.prepare("SELECT * FROM contexts").all() as unknown as ContextRow[]) {
        const context = JSON.parse(row.record) as Context;
        if (context.revokedAt !== null || context.expiresAt <= Date.now() || !config.slots.some((slot) => slot.slotId === context.slotId && slot.principalId === context.principalId)) quarantineContext(row.context_key, context);
      }
      resource.pumpQueue();
    };
    maintenance();

    const handle = async (slot: Slot, method: string, input: unknown, role: RpcRole): Promise<unknown> => {
      try {
        const operatorMethods = new Set(["resource_register", "resource_inspect", "resource_quarantine", "resource_reconcile", "resource_context_register", "resource_context_revoke"]);
        if (operatorMethods.has(method) && role !== "operator") throw new ResourceError("RESOURCE_OPERATOR_REQUIRED");
        if (method === "resource_status") {
          z.object({}).strict().parse(input);
          return { hostId: config.hostId, slotId: slot.slotId, principalId: slot.principalId, ready: maintenanceHealthy, sharedCoordinator: true, isolationEnforced: false, recoveryVerifierAvailable: false };
        }
        if (!maintenanceHealthy) throw new ResourceError("RESOURCE_HOST_MAINTENANCE_FAILED");
        if (method === "resource_register") { resource.registerResource(descriptorSchema.parse(input)); return { registered: true }; }
        if (method === "resource_inspect") { return resource.inspect(z.object({ resourceId: id }).strict().parse(input).resourceId); }
        if (method === "resource_quarantine") { const value = z.object({ resourceId: id, reason: z.string().regex(/^[A-Z0-9_]{1,96}$/) }).strict().parse(input); resource.quarantine(value.resourceId, value.reason); return { quarantined: true }; }
        if (method === "resource_reconcile") { throw new ResourceError("RECOVERY_VERIFIER_UNAVAILABLE"); }
        if (method === "resource_context_register") {
          const value = contextSchema.parse(input);
          if (value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 86_400_000 || new Set(value.resourceIds).size !== value.resourceIds.length) throw new ResourceError("INVALID_RESOURCE_CONTEXT_LIMIT");
          for (const resourceId of value.resourceIds) resource.inspect(resourceId);
          const key = contextKey(slot, value.contextId);
          const context: Context = { ...value, slotId: slot.slotId, principalId: slot.principalId, revokedAt: null };
          const existing = store.prepare("SELECT record FROM contexts WHERE context_key=?").get(key) as { record: string } | undefined;
          if (existing) {
            if (existing.record !== JSON.stringify(context)) throw new ResourceError("RESOURCE_CONTEXT_IMMUTABLE");
            return { contextId: value.contextId, registered: true };
          }
          if ((store.prepare("SELECT count(*) AS count FROM contexts").get() as { count: number }).count >= 4096) throw new ResourceError("RESOURCE_CONTEXT_QUOTA");
          if (store.prepare("SELECT 1 FROM contexts WHERE slot_id=? AND run_id=?").get(slot.slotId, value.runId)) throw new ResourceError("RESOURCE_RUN_CONTEXT_ALREADY_BOUND");
          store.prepare("INSERT INTO contexts VALUES (?, ?, ?, ?)").run(key, slot.slotId, value.runId, JSON.stringify(context));
          return { contextId: value.contextId, registered: true };
        }
        if (method === "resource_context_revoke") {
          const value = contextQuery.parse(input); const context = getContext(slot, value.contextId, false);
          context.revokedAt ??= Date.now();
          store.prepare("UPDATE contexts SET record=? WHERE context_key=?").run(JSON.stringify(context), contextKey(slot, value.contextId));
          quarantineContext(contextKey(slot, value.contextId), context);
          return { contextId: context.contextId, revoked: true };
        }
        if (method === "resource_acquire") {
          const value = z.object({ contextId: id, resourceIds: z.array(id).min(1).max(32), ttlMs: z.number().int().positive(), waitMs: z.number().int().min(0).max(300_000).default(0), idempotencyKey: id }).strict().parse(input);
          const context = getContext(slot, value.contextId);
          if (value.ttlMs > context.maxLeaseMs || value.resourceIds.some((resourceId) => !context.resourceIds.includes(resourceId))) throw new ResourceError("RESOURCE_CONTEXT_SCOPE_EXCEEDED");
          const remaining = context.expiresAt - Date.now();
          if (remaining < value.ttlMs || remaining < value.waitMs) throw new ResourceError("RESOURCE_CONTEXT_DURATION_EXCEEDED");
          const requestId = `rq-${digest(JSON.stringify([slot.slotId, slot.principalId, value.contextId, value.idempotencyKey]))}`;
          const key = contextKey(slot, value.contextId);
          if ((store.prepare("SELECT count(*) AS count FROM request_bindings WHERE context_key=?").get(key) as { count: number }).count >= 1024 && !store.prepare("SELECT 1 FROM request_bindings WHERE request_id=?").get(requestId)) throw new ResourceError("RESOURCE_CONTEXT_REQUEST_QUOTA");
          // Record intent before acquisition: a crash cannot leave an accepted waiter invisible to revocation.
          store.prepare("INSERT OR IGNORE INTO request_bindings VALUES (?, ?)").run(requestId, key);
          const result = resource.acquire({ requestId, owner: owner(context), resourceIds: value.resourceIds, ttlMs: value.ttlMs, waitMs: value.waitMs });
          return result;
        }
        if (method === "resource_request" || method === "resource_cancel_wait") {
          const value = requestQuery.parse(input); const context = getContext(slot, value.contextId, false);
          const binding = store.prepare("SELECT context_key FROM request_bindings WHERE request_id=?").get(value.requestId) as { context_key: string } | undefined;
          if (!binding || binding.context_key !== contextKey(slot, value.contextId)) throw new ResourceError("RESOURCE_REQUEST_CONTEXT_MISMATCH");
          return method === "resource_request" ? resource.queryRequest(value.requestId, owner(context)) : resource.cancelWait(value.requestId, owner(context));
        }
        if (["resource_lease", "resource_release", "resource_renew", "resource_validate"].includes(method)) {
          const schema = method === "resource_renew" ? leaseQuery.extend({ ttlMs: z.number().int().positive() }).strict()
            : method === "resource_validate" ? leaseQuery.extend({ resourceId: id }).strict() : leaseQuery;
          const value = schema.parse(input);
          const context = getContext(slot, value.contextId, method !== "resource_lease");
          const credential = value.credential;
          if (method === "resource_lease") return resource.queryLease(credential, owner(context));
          if (method === "resource_release") { const result = resource.release(credential, owner(context)); maintenance(); return result; }
          if (method === "resource_renew") {
            const ttlMs = (value as z.infer<typeof leaseQuery> & { ttlMs: number }).ttlMs;
            if (ttlMs > context.maxLeaseMs || Date.now() + ttlMs > context.expiresAt) throw new ResourceError("RESOURCE_CONTEXT_DURATION_EXCEEDED");
            return resource.renew(credential, owner(context), ttlMs);
          }
          return resource.validateToken((value as z.infer<typeof leaseQuery> & { resourceId: string }).resourceId, credential, owner(context));
        }
        throw new ResourceError("UNKNOWN_RESOURCE_METHOD");
      } catch (error) {
        if (!(error instanceof ResourceError) && !(error instanceof z.ZodError)) maintenanceHealthy = false;
        return { error: { code: error instanceof ResourceError ? error.code : error instanceof z.ZodError ? "INVALID_RESOURCE_ARGUMENT" : "RESOURCE_INTERNAL_FAILURE" } };
      }
    };

    for (const slot of config.slots) {
      const client = clientCredentials.get(slot.slotId)!;
      const server = await startRpcServer({ port: slot.port, clientToken: client.token, operatorToken: operatorCredential.token, handle: (method, input, role) => handle(slot, method, input, role) });
      servers.push(server); endpoints.push({ slotId: slot.slotId, principalId: slot.principalId, endpoint: server.url, clientTokenFile: client.file });
    }
    timer = setInterval(() => { if (!maintenanceHealthy) return; try { maintenance(); } catch { maintenanceHealthy = false; } }, 250);
    const pointer = { schemaVersion: "p05.resource-host.v1", hostId: config.hostId, endpoints, operatorTokenFile: operatorCredential.file, isolationEnforced: false };
    fs.writeFileSync(path.join(stateDir, "resource-host.json"), JSON.stringify(pointer, null, 2), { mode: 0o600 });
    return { ...pointer, close };
  } catch (error) { await close(); throw error; }
}
