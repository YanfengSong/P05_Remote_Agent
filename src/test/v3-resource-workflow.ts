import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ResourceCoordinator } from "../v3/resources/index.js";
import {
  ResourceConstrainedExecutor,
  WorkflowEngine,
  WorkflowError,
  WorkflowRegistry,
  type ControlledExecutor,
  type ExecutionSnapshot,
  type Json,
  type Schema,
  type SkillDefinition,
  type StateBackend,
  type WorkflowContext,
  type WorkflowDefinition
} from "../v3/workflows/index.js";

class SqliteState implements StateBackend {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(namespace TEXT,key TEXT,version INTEGER,value TEXT,PRIMARY KEY(namespace,key))");
  }
  async read(namespace: string, key: string) {
    const row = this.db.prepare("SELECT version,value FROM entries WHERE namespace=? AND key=?").get(namespace, key) as { version: number; value: string } | undefined;
    return row ? { version: Number(row.version), value: JSON.parse(String(row.value)) as Json } : undefined;
  }
  async compareAndSet(namespace: string, key: string, version: number | null, value: Json) {
    return Boolean(version === null
      ? this.db.prepare("INSERT OR IGNORE INTO entries VALUES(?,?,1,?)").run(namespace, key, JSON.stringify(value)).changes
      : this.db.prepare("UPDATE entries SET value=?,version=version+1 WHERE namespace=? AND key=? AND version=?").run(JSON.stringify(value), namespace, key, version).changes);
  }
  close() { this.db.close(); }
}

const directory = mkdtempSync(path.join(os.tmpdir(), "p05-v3-t54-"));
const workspace = path.join(directory, "workspace");
mkdirSync(workspace);
const state = new SqliteState(path.join(directory, "workflow.sqlite"));
const coordinator = ResourceCoordinator.open({ stateDir: path.join(directory, "resources"), hostId: "host-t54", maxWaitMs: 5_000, maxLeaseMs: 5_000 });
coordinator.registerResource({ resourceId: "device", kind: "test-device", stablePhysicalIdentity: "t54:device", mode: "exclusive-session", capacity: 1, adapter: "t54" });
coordinator.registerResource({ resourceId: "gpu", kind: "test-gpu", stablePhysicalIdentity: "t54:gpu", mode: "exclusive-session", capacity: 1, adapter: "t54" });
coordinator.registerResource({ resourceId: "license", kind: "test-license", stablePhysicalIdentity: "t54:license", mode: "exclusive-session", capacity: 1, adapter: "t54" });

const context: WorkflowContext = {
  principal: "operator",
  slotId: "A",
  hostId: "host-t54",
  workspaceId: "project",
  workspaceRoot: workspace,
  authorizationRevision: "auth-t54",
  authority: ["Read"],
  securityMode: "trusted-host"
};

type Inner = { id: string; key: string; capability: string; context: WorkflowContext; state: ExecutionSnapshot["state"] };
const innerById = new Map<string, Inner>();
const innerByKey = new Map<string, string>();
const completed = new Set<string>();
const cancelled: string[] = [];
const submissions: string[] = [];
const active = new Set<string>();
let sequence = 0;
let peak = 0;
let permitChecks = 0;

const inner: ControlledExecutor = {
  async submit(request) {
    assert.ok(request.resourcePermit, "resource-bound inner execution must receive a platform fencing permit");
    assert.equal(request.resourcePermit.owner.runId, request.runId);
    for (const lease of request.resourcePermit.leases) {
      assert.equal(coordinator.validateToken(lease.resourceId, lease, request.resourcePermit.owner).state, "ACTIVE");
      permitChecks++;
    }
    const previous = innerByKey.get(request.idempotencyKey);
    if (previous) return this.status(request.context, previous);
    const id = "inner-" + (++sequence);
    innerByKey.set(request.idempotencyKey, id);
    innerById.set(id, { id, key: request.idempotencyKey, capability: request.capability, context: structuredClone(request.context), state: "RUNNING" });
    submissions.push(request.capability);
    active.add(id);
    peak = Math.max(peak, active.size);
    return { executionId: id, state: "RUNNING" };
  },
  async status(requestContext, executionId) {
    const item = innerById.get(executionId);
    if (!item || JSON.stringify(item.context) !== JSON.stringify(requestContext)) throw new Error("INNER_NOT_FOUND");
    if (completed.has(item.capability) && item.state === "RUNNING") {
      item.state = "SUCCEEDED";
      active.delete(executionId);
    }
    return {
      executionId,
      state: item.state,
      ...(item.state === "SUCCEEDED" ? { result: item.capability } : {})
    };
  },
  async cancel(requestContext, executionId) {
    const item = innerById.get(executionId);
    if (!item || JSON.stringify(item.context) !== JSON.stringify(requestContext)) throw new Error("INNER_NOT_FOUND");
    if (!["SUCCEEDED", "FAILED", "DENIED", "EXPIRED", "CANCELLED", "UNKNOWN"].includes(item.state)) {
      item.state = "CANCELLED";
      active.delete(executionId);
      cancelled.push(item.capability);
    }
    return { executionId, state: item.state };
  },
  async find(requestContext, key) {
    const id = innerByKey.get(key);
    return id ? this.status(requestContext, id) : undefined;
  }
};

const executor = new ResourceConstrainedExecutor({
  state,
  coordinator,
  inner,
  executorId: "workflow-resource",
  executorBootId: "boot-t54",
  bindings: [
    { capability: "job-a", capabilityVersion: "1", resourceIds: ["device"], ttlMs: 2_000, waitMs: 1_000 },
    { capability: "job-b", capabilityVersion: "1", resourceIds: ["device"], ttlMs: 2_000, waitMs: 1_000 },
    { capability: "hold-gpu", capabilityVersion: "1", resourceIds: ["gpu"], ttlMs: 2_000, waitMs: 1_000 },
    { capability: "needs-bundle", capabilityVersion: "1", resourceIds: ["gpu", "license"], ttlMs: 2_000, waitMs: 80 }
  ]
});

const scope = { workspaceId: "project", authority: ["Read"], securityMode: "trusted-host" as const };
const nullSchema: Schema = { type: "null" };
const stringSchema: Schema = { type: "string", maxLength: 64 };
const pairSchema: Schema = {
  type: "object",
  properties: { a: stringSchema, b: stringSchema },
  required: ["a", "b"],
  additionalProperties: false
};
const truth = { op: "eq" as const, left: { literal: true as const }, right: { literal: true as const } };
const dod = [{ id: "done", condition: truth, evidence: { ref: "last" as const } }];
const budget = { maxCalls: 4, maxIterations: 2, maxParallel: 2, timeoutMs: 4_000 };

function skill(id: string, a: string, b: string, failurePolicy: "cancel-siblings" | "wait-all"): SkillDefinition {
  return {
    skillId: id,
    revision: "1",
    description: id,
    source: "t54-fixture",
    owner: "test",
    objective: id,
    scope,
    budget,
    inputSchema: nullSchema,
    outputSchema: pairSchema,
    requiredCapabilities: [{ capability: a, version: "1" }, { capability: b, version: "1" }],
    agentRequirements: [],
    body: {
      id: "parallel",
      kind: "parallel",
      failurePolicy,
      branches: [
        { key: "a", outputOwner: "a", authority: ["Read"], node: { id: "a-run", kind: "capability", capability: a, input: { literal: null } } },
        { key: "b", outputOwner: "b", authority: ["Read"], node: { id: "b-run", kind: "capability", capability: b, input: { literal: null } } }
      ]
    },
    dod,
    stopConditions: []
  };
}
function workflow(id: string, skillId: string): WorkflowDefinition {
  return {
    workflowId: id,
    revision: "1",
    description: id,
    scope,
    budget,
    inputSchema: nullSchema,
    outputSchema: pairSchema,
    entryStage: "main",
    stages: [{ stageId: "main", skillId, skillRevision: "1" }],
    dod
  };
}

const registry = new WorkflowRegistry({
  capabilities: [
    { capability: "job-a", version: "1", effect: "read" },
    { capability: "job-b", version: "1", effect: "read" },
    { capability: "hold-gpu", version: "1", effect: "read" },
    { capability: "needs-bundle", version: "1", effect: "read" }
  ]
});
registry.registerSkill(skill("serialized", "job-a", "job-b", "wait-all"));
registry.registerWorkflow(workflow("serialized", "serialized"));
registry.registerSkill(skill("bundle-timeout", "hold-gpu", "needs-bundle", "cancel-siblings"));
registry.registerWorkflow(workflow("bundle-timeout", "bundle-timeout"));

const engine = new WorkflowEngine({ registry, state, executor });
const activationSource = { source: "explicit" as const, reason: "T54 acceptance" };

try {
  await assert.rejects(executor.submit({
    context, capability: "job-a", capabilityVersion: "1", input: null, idempotencyKey: "injected-permit", runId: "manual-run",
    resourcePermit: { owner: { slotId: "A", runId: "manual-run", executorId: "fake", executorBootId: "fake-boot" }, leases: [] }
  }), (error: unknown) => error instanceof WorkflowError && error.code === "RESOURCE_PERMIT_INJECTION");

  const serial = await engine.start(context, { workflowId: "serialized", revision: "1", input: null, idempotencyKey: "serial", activationSource });
  let view = await engine.tick(context, serial.runId);
  assert.equal(view.state, "WAITING_EXECUTION");
  assert.deepEqual(submissions, ["job-a"], "second branch must not reach the inner executor while exclusive resource is held");
  assert.equal(peak, 1);
  assert.equal(coordinator.inspect("device").holders.length, 1);
  const epochA = coordinator.inspect("device").holders[0]!.fencingEpoch;

  completed.add("job-a");
  view = await engine.tick(context, serial.runId);
  assert.equal(view.state, "WAITING_EXECUTION");
  assert.deepEqual(submissions, ["job-a", "job-b"]);
  assert.equal(peak, 1, "resource serialization must cap real inner concurrency at one");
  assert.equal(coordinator.inspect("device").holders.length, 1);
  const epochB = coordinator.inspect("device").holders[0]!.fencingEpoch;
  assert.ok(epochB > epochA, "handover must advance the resource fencing epoch");

  completed.add("job-b");
  view = await engine.tick(context, serial.runId);
  assert.equal(view.state, "SUCCEEDED");
  assert.deepEqual(view.output, { a: "job-a", b: "job-b" });
  assert.equal(view.usedCalls, 2, "resource waiting must not create hidden Workflow tool-call retries");
  assert.equal(coordinator.inspect("device").holders.length, 0);

  const submissionsBeforeFailure = submissions.length;
  const failing = await engine.start(context, { workflowId: "bundle-timeout", revision: "1", input: null, idempotencyKey: "bundle-timeout", activationSource });
  view = await engine.tick(context, failing.runId);
  assert.equal(view.state, "WAITING_EXECUTION");
  assert.equal(submissions.length, submissionsBeforeFailure + 1);
  assert.equal(submissions.at(-1), "hold-gpu");
  assert.equal(coordinator.inspect("gpu").holders.length, 1);
  assert.equal(coordinator.inspect("license").holders.length, 0, "waiting multi-resource branch must not partially reserve the free member of its bundle");

  await sleep(120);
  view = await engine.tick(context, failing.runId);
  assert.equal(view.state, "FAILED");
  assert.equal(view.nodes["main/parallel/b/b-run"]?.executorState, "EXPIRED");
  assert.ok(cancelled.includes("hold-gpu"), "cancel-siblings must cancel the already-running resource holder");
  assert.equal(submissions.filter(item => item === "needs-bundle").length, 0, "expired resource waiter must never reach the inner executor");
  assert.equal(coordinator.inspect("gpu").holders.length, 0);
  assert.equal(coordinator.inspect("license").holders.length, 0);
  assert.equal(view.usedCalls, 2, "bounded resource contention consumes only the two declared branch calls");
  assert.equal(permitChecks, 3, "only the three admitted inner executions receive validated fencing permits");

  console.log("V3_T54_RESOURCE_PARALLEL_OK (real Workflow parallel branches, exclusive serialization, atomic bundle wait, fencing handover, bounded expiry, cancel-siblings cleanup, no hidden retries)");
} finally {
  coordinator.close();
  state.close();
  rmSync(directory, { recursive: true, force: true });
}
