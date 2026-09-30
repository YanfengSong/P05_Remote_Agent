import { createHash } from "node:crypto";
import type { ResourceCoordinator } from "../resources/coordinator.js";
import type { LeaseOwner, ResourceLease } from "../resources/types.js";
import { ResourceError } from "../resources/types.js";
import { copy, digest } from "./registry.js";
import {
  WorkflowError,
  type ControlledExecutor,
  type ExecutionRequest,
  type ExecutionSnapshot,
  type Json,
  type StateBackend,
  type WorkflowContext
} from "./types.js";

const terminal = new Set<ExecutionSnapshot["state"]>(["SUCCEEDED", "FAILED", "DENIED", "EXPIRED", "CANCELLED", "UNKNOWN"]);
export type ResourceBinding = {
  capability: string;
  capabilityVersion: string;
  resourceIds: string[];
  ttlMs: number;
  waitMs: number;
};
type RecordState = {
  context: WorkflowContext;
  request: ExecutionRequest;
  intentDigest: string;
  owner: LeaseOwner;
  requestId: string;
  snapshot: ExecutionSnapshot;
  leases: ResourceLease[];
  innerExecutionId?: string;
};

export type ResourceConstrainedExecutorOptions = {
  state: StateBackend;
  coordinator: ResourceCoordinator;
  inner: ControlledExecutor;
  executorId: string;
  executorBootId: string;
  bindings: ResourceBinding[];
};

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function wrapperId(key: string): string { return "res-" + createHash("sha256").update(key).digest("hex"); }
function requestId(request: ExecutionRequest): string { return "rr-" + createHash("sha256").update(JSON.stringify([request.context.slotId, request.context.principal, request.runId, request.idempotencyKey])).digest("hex"); }
function namespace(context: WorkflowContext): string {
  return "resource-executor:" + digest({ slotId: context.slotId, principal: context.principal, workspaceId: context.workspaceId });
}

export class ResourceConstrainedExecutor implements ControlledExecutor {
  private readonly bindings = new Map<string, ResourceBinding>();
  constructor(private readonly options: ResourceConstrainedExecutorOptions) {
    if (!validId(options.executorId) || !validId(options.executorBootId)) throw new WorkflowError("INVALID_RESOURCE_EXECUTOR_ID", "Resource executor identity is invalid");
    for (const binding of options.bindings) {
      if (!binding.capability || !binding.capabilityVersion || !Array.isArray(binding.resourceIds) || binding.resourceIds.length < 1 ||
        new Set(binding.resourceIds).size !== binding.resourceIds.length || !binding.resourceIds.every(validId) ||
        !Number.isSafeInteger(binding.ttlMs) || binding.ttlMs < 1 || !Number.isSafeInteger(binding.waitMs) || binding.waitMs < 1) {
        throw new WorkflowError("INVALID_RESOURCE_BINDING", "Resource binding is invalid");
      }
      const key = binding.capability + "@" + binding.capabilityVersion;
      if (this.bindings.has(key)) throw new WorkflowError("DUPLICATE_RESOURCE_BINDING", "Resource binding is duplicated");
      this.bindings.set(key, { ...binding, resourceIds: [...binding.resourceIds].sort() });
    }
  }

  private binding(request: ExecutionRequest): ResourceBinding | undefined {
    return this.bindings.get(request.capability + "@" + request.capabilityVersion);
  }

  private owner(request: ExecutionRequest): LeaseOwner {
    if (!request.runId || !validId(request.runId)) throw new WorkflowError("RESOURCE_RUN_ID_REQUIRED", "Resource constrained execution requires a trusted Run id");
    const executorId = "res:" + createHash("sha256").update(this.options.executorId + "\0" + request.idempotencyKey).digest("hex").slice(0, 48);
    return {
      slotId: request.context.slotId,
      runId: request.runId,
      executorId,
      executorBootId: this.options.executorBootId
    };
  }

  async submit(request: ExecutionRequest): Promise<ExecutionSnapshot> {
    if (request.resourcePermit) throw new WorkflowError("RESOURCE_PERMIT_INJECTION", "Resource permits are platform-generated only");
    const binding = this.binding(request);
    if (!binding) return this.options.inner.submit(request);
    const safe = copy(request);
    const id = wrapperId(request.idempotencyKey), ns = namespace(request.context), intentDigest = digest(safe);
    const existing = await this.options.state.read(ns, id);
    if (existing) {
      const record = existing.value as unknown as RecordState;
      if (record.intentDigest !== intentDigest) throw new WorkflowError("IDEMPOTENCY_CONFLICT", "Resource execution key intent changed");
      return this.advance(ns, id, existing.version, record);
    }
    const record: RecordState = {
      context: copy(request.context),
      request: safe,
      intentDigest,
      owner: this.owner(request),
      requestId: requestId(request),
      snapshot: { executionId: id, state: "QUEUED" },
      leases: []
    };
    if (!await this.options.state.compareAndSet(ns, id, null, copy(record) as unknown as Json)) return this.submit(request);
    const stored = await this.options.state.read(ns, id);
    if (!stored) throw new WorkflowError("STATE_CONFLICT", "Resource execution record disappeared");
    return this.advance(ns, id, stored.version, stored.value as unknown as RecordState);
  }

  private async save(ns: string, id: string, version: number, record: RecordState): Promise<{ version: number; record: RecordState }> {
    if (!await this.options.state.compareAndSet(ns, id, version, copy(record) as unknown as Json)) {
      const current = await this.options.state.read(ns, id);
      if (!current) throw new WorkflowError("STATE_CONFLICT", "Resource execution record disappeared");
      return { version: current.version, record: current.value as unknown as RecordState };
    }
    return { version: version + 1, record };
  }

  private async release(record: RecordState): Promise<void> {
    for (const lease of record.leases) {
      try { this.options.coordinator.release(lease, record.owner); }
      catch (error) {
        if (!(error instanceof ResourceError) || !["LEASE_NOT_ACTIVE"].includes(error.code)) throw error;
      }
    }
    record.leases = [];
    this.options.coordinator.pumpQueue();
  }

  private view(id: string, snapshot: ExecutionSnapshot): ExecutionSnapshot {
    return { ...copy(snapshot), executionId: id };
  }

  private async advance(ns: string, id: string, version: number, record: RecordState): Promise<ExecutionSnapshot> {
    if (digest(record.context) !== digest(record.request.context)) throw new WorkflowError("RESOURCE_EXECUTION_CONTEXT_CORRUPT", "Stored resource execution context changed");
    if (terminal.has(record.snapshot.state)) return copy(record.snapshot);
    const binding = this.binding(record.request);
    if (!binding) throw new WorkflowError("RESOURCE_BINDING_MISSING", "Pinned resource binding disappeared");

    if (!record.innerExecutionId) {
      this.options.coordinator.pumpQueue();
      let resourceRequest;
      try {
        resourceRequest = this.options.coordinator.acquire({
          requestId: record.requestId,
          owner: record.owner,
          resourceIds: binding.resourceIds,
          ttlMs: binding.ttlMs,
          waitMs: binding.waitMs
        });
        if (resourceRequest.state === "WAITING") resourceRequest = this.options.coordinator.queryRequest(record.requestId, record.owner);
      } catch (error) {
        if (error instanceof ResourceError) {
          record.snapshot = { executionId: id, state: "FAILED", result: { code: error.code } };
          await this.save(ns, id, version, record);
          return copy(record.snapshot);
        }
        throw error;
      }
      if (resourceRequest.state === "WAITING" || resourceRequest.state === "BUSY") {
        record.snapshot = { executionId: id, state: "QUEUED" };
        await this.save(ns, id, version, record);
        return copy(record.snapshot);
      }
      if (resourceRequest.state === "EXPIRED" || resourceRequest.state === "CANCELLED") {
        record.snapshot = { executionId: id, state: resourceRequest.state === "EXPIRED" ? "EXPIRED" : "CANCELLED", result: { code: "RESOURCE_" + resourceRequest.state } };
        await this.save(ns, id, version, record);
        return copy(record.snapshot);
      }
      if (resourceRequest.state !== "GRANTED" || resourceRequest.leases.length !== binding.resourceIds.length) throw new WorkflowError("RESOURCE_GRANT_INVALID", "Resource grant is incomplete");
      record.leases = resourceRequest.leases.map(lease => ({ ...lease }));
      const submitted = await this.options.inner.submit({ ...record.request, resourcePermit: { owner: { ...record.owner }, leases: record.leases.map(lease => ({ resourceId: lease.resourceId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch, token: lease.token })) } });
      record.innerExecutionId = submitted.executionId;
      record.snapshot = this.view(id, submitted);
      if (terminal.has(submitted.state)) await this.release(record);
      const saved = await this.save(ns, id, version, record);
      return copy(saved.record.snapshot);
    }

    const observed = await this.options.inner.status(record.context, record.innerExecutionId);
    record.snapshot = this.view(id, observed);
    if (terminal.has(observed.state)) await this.release(record);
    const saved = await this.save(ns, id, version, record);
    return copy(saved.record.snapshot);
  }

  async status(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    if (!executionId.startsWith("res-")) return this.options.inner.status(context, executionId);
    const ns = namespace(context), stored = await this.options.state.read(ns, executionId);
    if (!stored) throw new WorkflowError("NOT_FOUND", "Resource execution not found");
    const record = stored.value as unknown as RecordState;
    if (digest(record.context) !== digest(context)) throw new WorkflowError("NOT_FOUND", "Resource execution context mismatch");
    return this.advance(ns, executionId, stored.version, record);
  }

  async find(context: WorkflowContext, key: string): Promise<ExecutionSnapshot | undefined> {
    const bindingId = wrapperId(key), stored = await this.options.state.read(namespace(context), bindingId);
    if (stored) return this.status(context, bindingId);
    return this.options.inner.find?.(context, key);
  }

  async cancel(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot> {
    if (!executionId.startsWith("res-")) return this.options.inner.cancel(context, executionId);
    const ns = namespace(context), stored = await this.options.state.read(ns, executionId);
    if (!stored) throw new WorkflowError("NOT_FOUND", "Resource execution not found");
    const record = stored.value as unknown as RecordState;
    if (digest(record.context) !== digest(context)) throw new WorkflowError("NOT_FOUND", "Resource execution context mismatch");
    if (terminal.has(record.snapshot.state)) return copy(record.snapshot);

    if (!record.innerExecutionId) {
      try {
        const request = this.options.coordinator.queryRequest(record.requestId, record.owner);
        if (request.state === "WAITING") this.options.coordinator.cancelWait(record.requestId, record.owner);
        else if (request.state === "GRANTED") {
          record.leases = request.leases.map(lease => ({ ...lease }));
          await this.release(record);
        }
      } catch (error) {
        if (!(error instanceof ResourceError) || !["REQUEST_NOT_FOUND_OR_NOT_OWNED"].includes(error.code)) throw error;
      }
      record.snapshot = { executionId, state: "CANCELLED" };
      await this.save(ns, executionId, stored.version, record);
      return copy(record.snapshot);
    }

    const cancelled = await this.options.inner.cancel(context, record.innerExecutionId);
    record.snapshot = this.view(executionId, cancelled);
    if (terminal.has(cancelled.state)) await this.release(record);
    await this.save(ns, executionId, stored.version, record);
    return copy(record.snapshot);
  }
}
