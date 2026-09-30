import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { CoreRuntime } from "./core/index.js";
import { DurableStore } from "./durable/store.js";
import { createDurableKernel } from "./durable/kernel.js";
import { DurableError, type Json } from "./durable/types.js";
import { afterRpcResponse, startRpcServer, type RpcRole } from "./transport/rpc.js";
import { beginLifecycleRestart, claimLifecycleRestart, completeLifecycleRestart as completeLifecycleRestartRecord, lifecycleRestartStatus, type LifecycleRestartRecord } from "./lifecycle.js";
import { readV3Config } from "./config.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";
import { verifyBootstrapTrustManifest } from "./trust.js";
import { loadOrCreateToken } from "./credentials.js";
import { createFileCapabilities, FILE_CAPABILITY_METADATA, publicRun, validateFileInput, validateFileTarget } from "./file-capabilities.js";
import { V2OptionalHost } from "./optional/v2-host.js";
import { createWorkflowService } from "./workflow-service.js";
import { WorkflowError } from "./workflows/types.js";
import { createProcessBridge, validateProcessInput } from "./process-bridge.js";
import { createComponentBridge } from "./component-bridge.js";

const id = z.string().min(1).max(160);
const querySchema = z.object({ id }).strict();
const submitSchema = z.object({ capability: id, input: z.json(), idempotencyKey: z.string().min(1).max(256) }).strict();
const waitSchema = z.object({ id, afterVersion: z.number().int().nonnegative().default(0), waitMs: z.number().int().min(0).max(30000).default(1000) }).strict();
const eventsSchema = z.object({ id, afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }).strict();

export type PublicCapabilityMetadata = {
  capability: string;
  effect: "E0" | "E1" | "E2" | "E3" | "E4";
  authority: readonly string[];
  inputSchema: unknown;
  executionIdentity: "run-context";
  backend: string;
  [key: string]: unknown;
};
type RegisteredCapability = { capability: string; capabilityVersion: string; bindingVersion: string };

function withBackend<T extends { capability: string; effect: string; authority: readonly string[]; inputSchema: unknown }>(
  metadata: T, backend: string
): PublicCapabilityMetadata {
  return { ...metadata, effect: metadata.effect as PublicCapabilityMetadata["effect"], executionIdentity: "run-context", backend };
}

export function validatePublicCapabilityCatalog(
  capabilities: readonly RegisteredCapability[],
  metadata: readonly PublicCapabilityMetadata[]
): PublicCapabilityMetadata[] {
  const registered = new Set<string>();
  for (const capability of capabilities) {
    if (!/^[a-z][a-z0-9:_-]{0,159}$/.test(capability.capability) || !capability.capabilityVersion.trim() || !capability.bindingVersion.trim())
      throw new DurableError("CAPABILITY_CATALOG_INVALID", "Capability identity is incomplete");
    if (registered.has(capability.capability)) throw new DurableError("CAPABILITY_CATALOG_INVALID", "Duplicate capability registration");
    registered.add(capability.capability);
  }
  const declared = new Set<string>();
  for (const item of metadata) {
    if (!/^E[0-4]$/.test(item.effect) || item.executionIdentity !== "run-context" ||
        !/^[a-z][a-z0-9._:-]{0,95}$/.test(item.backend) || !item.authority.length || item.inputSchema === undefined)
      throw new DurableError("CAPABILITY_CATALOG_INVALID", "Capability metadata is incomplete");
    if (declared.has(item.capability)) throw new DurableError("CAPABILITY_CATALOG_INVALID", "Duplicate capability metadata");
    declared.add(item.capability);
  }
  if (registered.size !== declared.size || [...registered].some(capability => !declared.has(capability)))
    throw new DurableError("CAPABILITY_CATALOG_INVALID", "Registered capabilities and public metadata differ");
  return metadata.map(item => ({ ...item, authority: [...item.authority] }));
}

/** One application per process: V2 file guards are deliberately kept at their original module boundary. */
export interface V3LifecycleHooks { restartAfterAck?: (lifecycleId: string) => void | Promise<void>; }
export async function startV3Application(configFile: string, maintenance: { recoverUncleanOwner?: { coreInstanceId: string; reason: string } } = {}, lifecycle: V3LifecycleHooks = {}) {
  if (!(await verifyStateProtection(path.dirname(path.resolve(configFile)))).verified) throw new Error("CONFIGURATION_PARENT_PROTECTION_UNVERIFIED");
  if (!(await verifyConfigurationProtection(configFile)).verified) throw new Error("CONFIGURATION_PROTECTION_UNVERIFIED");
  const config = readV3Config(configFile);
  const trust = await verifyBootstrapTrustManifest(config.trustManifest, config);
  const optional = config.optionalRuntime ? new V2OptionalHost({
    nodeExecutable: process.execPath, entrypoint: fileURLToPath(new URL("../index.js", import.meta.url)),
    workspaceRoot: config.workspaceRoot, slot: config.slotId, stateDir: config.stateDir,
    profile: "readonly", capabilities: { git_status: "git_status", git_diff: "git_diff" }
  }) : undefined;
  const core = await CoreRuntime.start({
    stateDir: config.stateDir, slotId: config.slotId,
    workspaceRoots: [config.workspaceRoot], verifyProtection: verifyStateProtection,
    ...(maintenance.recoverUncleanOwner ? { recoverUncleanOwner: maintenance.recoverUncleanOwner } : {}),
    ...(optional && trust.verified ? { connectOptional: async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => { void optional.close(); }, { once: true });
      const health = await optional.start();
      if (health.state !== "ready") throw new Error("OPTIONAL_HOST_UNAVAILABLE");
    } } : {})
  });
  const slotDir = core.state.slotDir;
  let kernel: ReturnType<typeof createDurableKernel>["kernel"] | undefined;
  let server: Awaited<ReturnType<typeof startRpcServer>> | undefined;
  let workflows: Awaited<ReturnType<typeof createWorkflowService>> | undefined;
  const release = async () => {
    const errors: unknown[] = [];
    try { await server?.close(); } catch (error) { errors.push(error); }
    try { await workflows?.close(); } catch (error) { errors.push(error); }
    try { await kernel?.close(); } catch (error) { errors.push(error); }
    try { await optional?.close(); } catch (error) { errors.push(error); }
    try { core.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
  };
  try {
    // Credentials and resumable payloads are not written into an unverified shared directory.
    if (!core.status().protection.verified) throw new Error("STATE_PROTECTION_UNVERIFIED: local setup is required");
    const client = loadOrCreateToken(slotDir, "client");
    const localOperator = loadOrCreateToken(slotDir, "operator");
    if (!(await verifyStateProtection(slotDir)).verified) throw new Error("SLOT_PROTECTION_UNVERIFIED");
    if (!trust.verified) {
      const lockedStatus = () => {
        const current = core.status();
        return { ...current, mode: "LOCKED" as const, trust, readiness: { ...current.readiness, recovery: false, mutations: false, optional: false },
          optional: null, processHost: { configured: Boolean(config.processHostConnection), enabled: config.allowHostExecute, connectedAtStartup: false },
          workflow: { configured: Boolean(config.workflowCatalog), available: false, faultCode: null },
          componentHost: { configured: Boolean(config.componentHostConnection), connectedAtStartup: false, capabilityCount: 0 },
          features: { fileCapabilities: true, durableRuns: false, durableApprovals: false, osSandbox: false, separateExecutionHost: false, optionalPluginHost: false } };
      };
      const lockedHandle = async (method: string): Promise<unknown> => method === "core_status" ? lockedStatus() : { error: { code: "CORE_LOCKED" } };
      server = await startRpcServer({ clientToken: client.token, operatorToken: localOperator.token, handle: lockedHandle, port: config.port });
      core.setConnectionState("connected");
      const connection = { endpoint: server.url, slotId: config.slotId, clientTokenFile: client.file };
      fs.writeFileSync(path.join(slotDir, "connection.json"), JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
      let closing: Promise<void> | undefined;
      return { ...connection, operatorTokenFile: localOperator.file, status: lockedStatus,
        completeLifecycleRestart(_lifecycleId: string): LifecycleRestartRecord { throw new DurableError("CORE_LOCKED", "Lifecycle health cannot complete while Core is locked"); },
        close(): Promise<void> { return closing ??= release(); } };
    }
    // V2 config must capture this process's fixed workspace before its first dynamic import.
    process.env.REMOTE_AGENT_ALLOWED_ROOTS = config.workspaceRoot;
    process.env.REMOTE_AGENT_DEFAULT_CWD = config.workspaceRoot;
    const capabilities = await createFileCapabilities();
    let components: Awaited<ReturnType<typeof createComponentBridge>> | undefined;
    if (config.componentHostConnection && config.componentCapabilities.length) {
      try {
        components = await createComponentBridge({ connectionFile: config.componentHostConnection, slotId: config.slotId,
          principal: config.principal, workspaceRoot: config.workspaceRoot, allowlist: config.componentCapabilities });
        capabilities.push(...components.capabilities);
      } catch { /* Installed components are optional, never a minimal Core startup dependency. */ }
    }
    let processBridge: Awaited<ReturnType<typeof createProcessBridge>> | undefined;
    if (config.processHostConnection && config.allowHostExecute) {
      try {
        processBridge = await createProcessBridge({ connectionFile: config.processHostConnection,
          slotId: config.slotId, principal: config.principal, workspaceRoot: config.workspaceRoot });
        capabilities.push(...processBridge.capabilities);
      } catch { /* Process dependency failure must not take the minimal Core offline. */ }
    }
    const validateInput = (capability: string, input: Json) => {
      if (capability.startsWith("component:")) {
        if (!components) throw new DurableError("DEPENDENCY_UNAVAILABLE", "Component Host unavailable");
        components.validateInput(capability, input);
      }
      else if (capability === "process_run") {
        if (!processBridge) throw new DurableError("DEPENDENCY_UNAVAILABLE", "Process Host unavailable or disabled");
        validateProcessInput(capability, input);
      }
      else if (optional && capability === "git_status") z.object({}).strict().parse(input);
      else if (optional && capability === "git_diff") z.object({ staged: z.boolean().optional() }).strict().parse(input);
      else validateFileInput(capability, input);
    };
    if (optional) {
      for (const capability of ["git_status", "git_diff"]) capabilities.push({
        capability, capabilityVersion: "1", bindingVersion: "v2-readonly-bridge.1",
        async execute({ input, signal }) {
          await core.optionalSettled;
          if (optional.health().state !== "ready") throw new DurableError("DEPENDENCY_UNAVAILABLE", "Optional runtime unavailable");
          let call = await optional.call(capability, input as Record<string, unknown>, { waitMs: 25 });
          while (call.state === "pending" && !signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 25));
            const next = optional.callStatus(call.callId);
            if (!next) throw new DurableError("OPTIONAL_CALL_LOST", "Optional call receipt unavailable");
            call = next;
          }
          if (call.state !== "completed") throw new DurableError("OPTIONAL_OUTCOME_UNCONFIRMED", "Read-only downstream result unconfirmed");
          if (call.result?.isError) throw new DurableError("DOWNSTREAM_TOOL_ERROR", "Read-only downstream tool failed");
          return (call.result?.structuredContent ?? call.result ?? null) as Json;
        }
      });
    }
    const capabilityCatalog = validatePublicCapabilityCatalog(capabilities, [
      ...FILE_CAPABILITY_METADATA.map(item => withBackend(item, "trusted-host:file-adapter")),
      ...(processBridge?.metadata ?? []).map(item => withBackend(item, "process-host")),
      ...(components?.metadata ?? []).map(item => withBackend(item, "component-host")),
      ...(optional ? [
        withBackend({ capability: "git_status", effect: "E0", authority: ["Read"], inputSchema: z.toJSONSchema(z.object({}).strict()) }, "v2-optional-host"),
        withBackend({ capability: "git_diff", effect: "E0", authority: ["Read"], inputSchema: z.toJSONSchema(z.object({ staged: z.boolean().optional() }).strict()) }, "v2-optional-host")
      ] : [])
    ]);
    const owner = { principal: config.principal, slotId: config.slotId };
    const context = {
      ...owner, hostId: core.state.identity.hostId, workspaceId: config.workspaceId,
      workspaceRoot: config.workspaceRoot, authorizationRevision: config.authorizationRevision
    };
    const store = new DurableStore(path.join(slotDir, "runs.sqlite"));
    const created = createDurableKernel({
      store,
      authorize(run, input) {
        validateInput(run.capability, input);
        if (!["fs_write", "process_run"].includes(run.capability)) return { decision: "ALLOW" };
        const enabled = run.capability === "process_run" ? config.allowHostExecute : config.allowWrites;
        if (!enabled || !config.trustedHost || !core.status().readiness.mutations) {
          return { decision: "DENY", reason: "WORKSPACE_WRITE_NOT_AUTHORIZED" };
        }
        return { decision: "CONFIRM", reason: run.capability === "process_run" ? "HostExecute E4: unrestricted trusted-host process; inspect executable and args with the local Operator" : "Workspace file mutation; inspect the immutable intent with the local Operator", expiresAt: Date.now() + 15 * 60 * 1000 };
      },
      async revalidate(run) {
        if (!(await verifyConfigurationProtection(configFile)).verified || !(await verifyStateProtection(path.dirname(path.resolve(configFile)))).verified) return false;
        const current = readV3Config(configFile);
        if (current.principal !== run.context.principal || current.slotId !== run.context.slotId ||
            current.workspaceId !== run.context.workspaceId || current.workspaceRoot !== run.context.workspaceRoot ||
            current.authorizationRevision !== run.context.authorizationRevision) return false;
        if (fs.realpathSync(config.workspaceRoot) !== config.workspaceRoot) return false;
        if (run.capability.startsWith("component:")) return current.componentHostConnection === config.componentHostConnection && current.componentCapabilities.includes(run.capability.slice("component:".length));
        if (run.capability === "process_run") return current.allowHostExecute && current.trustedHost && current.processHostConnection === config.processHostConnection && core.status().readiness.mutations;
        return run.capability !== "fs_write" || (current.allowWrites && current.trustedHost && core.status().readiness.mutations);
      }
    });
    kernel = created.kernel;
    const activeKernel = kernel;
    for (const capability of capabilities) activeKernel.register(capability);
    if (config.workflowCatalog) {
      try {
        workflows = await createWorkflowService({
          // HostExecute is not part of the current Workflow Read/WorkspaceWrite authority model.
          catalogFile: config.workflowCatalog, state: core.state, kernel: activeKernel, context, capabilities: capabilities.filter(c => c.capability !== "process_run"),
          authority: config.allowWrites ? ["Read", "WorkspaceWrite"] : ["Read"], autoAdvance: config.workflowAutoAdvance
        });
      } catch { /* A broken optional catalog must leave diagnostics and recovery reachable. */ }
    }
    const status = () => {
      const current = core.status();
      const execution = activeKernel.health();
      const dependencyUnavailable = Boolean(config.workflowCatalog && !workflows) || Boolean(config.allowHostExecute && !processBridge) || Boolean(config.componentHostConnection && config.componentCapabilities.length && !components);
      return { ...current, trust, mode: !execution.executionAvailable ? "LOCKED" : dependencyUnavailable && current.mode === "NORMAL" ? "DEGRADED" : current.mode,
        readiness: { ...current.readiness, mutations: current.readiness.mutations && execution.executionAvailable }, execution,
        optional: optional?.health() ?? null,
        processHost: { configured: Boolean(config.processHostConnection), enabled: config.allowHostExecute, connectedAtStartup: Boolean(processBridge) },
        workflow: { configured: Boolean(config.workflowCatalog), available: Boolean(workflows), faultCode: config.workflowCatalog && !workflows ? "WORKFLOW_CATALOG_UNAVAILABLE" : null },
        componentHost: { configured: Boolean(config.componentHostConnection), connectedAtStartup: Boolean(components), capabilityCount: components?.capabilities.length ?? 0 },
        features: { fileCapabilities: true, durableRuns: true, durableApprovals: true, osSandbox: false, separateExecutionHost: Boolean(processBridge), optionalPluginHost: Boolean(optional) } };
    };
    const handle = async (method: string, input: unknown, role: RpcRole): Promise<unknown> => {
      try {
        switch (method) {
          case "operator_lifecycle_restart": {
            if (role !== "operator") throw new DurableError("FORBIDDEN", "Operator role required");
            if (!lifecycle.restartAfterAck) throw new DurableError("LIFECYCLE_SUPERVISOR_UNAVAILABLE", "Lifecycle supervisor unavailable");
            const request = z.object({ idempotencyKey: z.string().min(1).max(256) }).strict().parse(input);
            const pending = beginLifecycleRestart(core.state, request.idempotencyKey);
            if (pending.record.state !== "ACK_PENDING") return pending.record;
            return afterRpcResponse(pending.record, async () => {
              const claimed = claimLifecycleRestart(core.state, pending.record.lifecycleId);
              if (claimed) await lifecycle.restartAfterAck!(pending.record.lifecycleId);
            });
          }
          case "operator_lifecycle_status": {
            if (role !== "operator") throw new DurableError("FORBIDDEN", "Operator role required");
            const lifecycleId = querySchema.parse(input).id;
            const record = lifecycleRestartStatus(core.state, lifecycleId);
            if (!record) throw new DurableError("LIFECYCLE_NOT_FOUND", "Lifecycle run not found");
            return record;
          }
          case "workflow_list":
          case "workflow_scheduler_status":
          case "workflow_resume":
          case "workflow_start":
          case "workflow_status":
          case "workflow_tick":
          case "workflow_cancel": {
            if (!workflows) throw new DurableError("DEPENDENCY_UNAVAILABLE", "No local workflow catalog configured");
            return await workflows.handle(method, input);
          }
          case "core_status": return status();
          case "capability_list": return { capabilities: capabilityCatalog.filter(c => c.capability !== "fs_write" || config.allowWrites),
            securityMode: "trusted-host" };
          case "execution_submit": {
            const request = submitSchema.parse(input);
            validateInput(request.capability, request.input as Json);
            await validateFileTarget(request.capability, request.input as Json, config.workspaceRoot);
            return publicRun(activeKernel.submit(context, request));
          }
          case "execution_status": return publicRun(activeKernel.status(owner, querySchema.parse(input).id));
          case "execution_process_status": {
            if (!processBridge) throw new DurableError("DEPENDENCY_UNAVAILABLE", "Process Host unavailable");
            return await processBridge.statusForRun(activeKernel.status(owner, querySchema.parse(input).id));
          }
          case "execution_process_output": {
            if (!processBridge) throw new DurableError("DEPENDENCY_UNAVAILABLE", "Process Host unavailable");
            const request = z.object({ id, stream: z.enum(["stdout", "stderr"]).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional() }).strict().parse(input);
            return await processBridge.outputForRun(activeKernel.status(owner, request.id), request);
          }
          case "execution_wait": {
            const request = waitSchema.parse(input);
            const result = await activeKernel.wait(owner, request.id, request.afterVersion, request.waitMs);
            return { ...result, run: publicRun(result.run) };
          }
          case "execution_events": {
            const request = eventsSchema.parse(input);
            const events = activeKernel.events(owner, request.id, request.afterSequence, request.limit);
            return { events, nextSequence: events.at(-1)?.sequence ?? request.afterSequence };
          }
          case "execution_cancel": {
            const run = activeKernel.cancel(owner, querySchema.parse(input).id);
            if (run.capability === "process_run" && run.state === "UNKNOWN") {
              if (!processBridge) return { ...publicRun(run), processCancellation: { code: "DEPENDENCY_UNAVAILABLE", terminationConfirmed: false } };
              try {
                const process = await processBridge.cancelForRun(run);
                return { ...publicRun(run), processCancellation: { state: process.state, receipt: process.receipt ?? null, treeTermination: "unconfirmed" } };
              } catch { return { ...publicRun(run), processCancellation: { code: "PROCESS_CANCEL_UNCONFIRMED", terminationConfirmed: false } }; }
            }
            return publicRun(run);
          }
          case "operator_approvals": {
            if (role !== "operator") throw new DurableError("FORBIDDEN", "Operator role required");
            return { approvals: created.operator.pending(config.slotId).map(approval => ({
              ...approval, run: publicRun(store.internal(approval.executionId))
            })) };
          }
          case "operator_inspect": {
            if (role !== "operator") throw new DurableError("FORBIDDEN", "Operator role required");
            const executionId = querySchema.parse(input).id;
            const run = store.internal(executionId);
            if (run.context.slotId !== config.slotId) throw new DurableError("FORBIDDEN", "Wrong Slot");
            return { run, input: store.input(executionId) };
          }
          case "operator_decide": {
            if (role !== "operator") throw new DurableError("FORBIDDEN", "Operator role required");
            const request = z.object({ approvalId: id, expectedDecisionVersion: z.number().int().nonnegative(), decision: z.enum(["APPROVE", "DENY"]) }).strict().parse(input);
            return publicRun(created.operator.decide({ ...request, actor: "authenticated-local-operator" }));
          }
          default: throw new DurableError("UNKNOWN_METHOD", "Unsupported operation");
        }
      } catch (error) {
        // Safe domain codes are data; transport failures remain distinct from execution outcomes.
        if (error instanceof DurableError || error instanceof WorkflowError) return { error: { code: error.code } };
        if (error instanceof z.ZodError) return { error: { code: "INVALID_ARGUMENT" } };
        throw error;
      }
    };
    server = await startRpcServer({ clientToken: client.token, operatorToken: localOperator.token, handle, port: config.port });
    core.setConnectionState("connected");
    const connection = { endpoint: server.url, slotId: config.slotId, clientTokenFile: client.file };
    fs.writeFileSync(path.join(slotDir, "connection.json"), JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
    let closing: Promise<void> | undefined;
    return {
      ...connection, operatorTokenFile: localOperator.file,
      status,
      completeLifecycleRestart(lifecycleId: string): LifecycleRestartRecord {
        const current = status();
        return completeLifecycleRestartRecord(core.state, lifecycleId, {
          liveness: current.liveness, mode: current.mode, protectionVerified: current.protection.verified,
          executionAvailable: current.execution.executionAvailable
        });
      },
      close(): Promise<void> {
        return closing ??= release();
      }
    };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}
