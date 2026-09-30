import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CliAgentProvider,
  ProtocolAgentProvider,
  WorkflowError,
  WorkflowEngine,
  WorkflowRegistry,
  type Budget,
  type ControlledExecutor,
  type ExecutionSnapshot,
  type Json,
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

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = mkdtempSync(path.join(os.tmpdir(), "p05-v3-t47-"));
const workspace = path.join(fixture, "workspace");
mkdirSync(workspace);
const state = new SqliteState(path.join(fixture, "state.sqlite"));
const cliScript = path.join(here, "fixtures", "agent-cli-fixture.js");
const protocolScript = path.join(here, "fixtures", "agent-protocol-fixture.js");

const context: WorkflowContext = {
  principal: "alice",
  slotId: "A",
  hostId: "host",
  workspaceId: "project",
  workspaceRoot: workspace,
  authorizationRevision: "auth-1",
  authority: ["Read"],
  securityMode: "trusted-host"
};
const scope = { workspaceId: "project", authority: ["Read"], securityMode: "trusted-host" as const };
const truth = { op: "eq" as const, left: { literal: true as const }, right: { literal: true as const } };
const dod = [{ id: "done", condition: truth, evidence: { ref: "last" as const } }];
const numberSchema = { type: "number" as const, minimum: 0, maximum: 100 };
const nullSchema = { type: "null" as const };
const activationSource = { source: "explicit" as const, reason: "T47 acceptance" };

const snapshots = new Map<string, ExecutionSnapshot>();
const idempotency = new Map<string, string>();
let readCalls = 0;
let writeCalls = 0;
let narrowedAuthorityChecks = 0;
const toolExecutor: ControlledExecutor = {
  async submit(request) {
    const previous = idempotency.get(request.idempotencyKey);
    if (previous) return snapshots.get(previous)!;
    const executionId = "tool-" + request.idempotencyKey;
    idempotency.set(request.idempotencyKey, executionId);
    if (request.capability === "read.echo") {
      readCalls++;
      assert.deepEqual(request.context.authority, ["Read"]);
      narrowedAuthorityChecks++;
      const value = request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? Number((request.input as Record<string, Json>).value)
        : NaN;
      const snapshot: ExecutionSnapshot = { executionId, state: "SUCCEEDED", result: value };
      snapshots.set(executionId, snapshot);
      return snapshot;
    }
    if (request.capability === "write.secret") {
      writeCalls++;
      const snapshot: ExecutionSnapshot = request.context.authority.includes("WorkspaceWrite")
        ? { executionId, state: "SUCCEEDED", result: 99 }
        : { executionId, state: "DENIED", result: { code: "AUTHORITY_REQUIRED" } };
      snapshots.set(executionId, snapshot);
      return snapshot;
    }
    const snapshot: ExecutionSnapshot = { executionId, state: "DENIED", result: { code: "UNKNOWN_TOOL" } };
    snapshots.set(executionId, snapshot);
    return snapshot;
  },
  async status(_context, executionId) {
    const snapshot = snapshots.get(executionId);
    if (!snapshot) throw new Error("tool not found");
    return snapshot;
  },
  async cancel(_context, executionId) {
    const prior = snapshots.get(executionId);
    if (!prior) throw new Error("tool not found");
    const snapshot: ExecutionSnapshot = { ...prior, state: "CANCELLED" };
    snapshots.set(executionId, snapshot);
    return snapshot;
  },
  async find(_context, key) {
    const executionId = idempotency.get(key);
    return executionId ? snapshots.get(executionId) : undefined;
  }
};

const cli = new CliAgentProvider({
  providerId: "cli-agent", revision: "1", state, toolExecutor,
  command: process.execPath, args: [cliScript]
});
const protocol = new ProtocolAgentProvider({
  providerId: "protocol-agent", revision: "1", state, toolExecutor,
  modulePath: protocolScript
});

const registry = new WorkflowRegistry({
  capabilities: [
    { capability: "read.echo", version: "1", effect: "read" },
    { capability: "write.secret", version: "1", effect: "write" }
  ],
  agents: [
    { providerId: "cli-agent", revision: "1", effect: "read" },
    { providerId: "protocol-agent", revision: "1", effect: "read" }
  ]
});

function agentSkill(id: string, provider: string, scenario: string, budget: Budget, capabilities = ["read.echo"]): SkillDefinition {
  return {
    skillId: id,
    revision: "1",
    description: id,
    source: "t47-fixture",
    owner: "test",
    objective: id,
    scope,
    budget,
    inputSchema: nullSchema,
    outputSchema: numberSchema,
    requiredCapabilities: capabilities.map(capability => ({ capability, version: "1" })),
    agentRequirements: [provider],
    body: {
      id: "agent",
      kind: "agent",
      provider,
      input: { literal: { scenario, value: 7 } }
    },
    dod,
    stopConditions: []
  };
}
function workflow(id: string, skillId: string, budget: Budget): WorkflowDefinition {
  return {
    workflowId: id,
    revision: "1",
    description: id,
    scope,
    inputSchema: nullSchema,
    outputSchema: numberSchema,
    budget,
    entryStage: "main",
    stages: [{ stageId: "main", skillId, skillRevision: "1" }],
    dod
  };
}
function register(id: string, provider: string, scenario: string, budget: Budget, capabilities = ["read.echo"]) {
  registry.registerSkill(agentSkill(id, provider, scenario, budget, capabilities));
  registry.registerWorkflow(workflow(id, id, budget));
}

const normalBudget = { maxCalls: 3, maxIterations: 3, maxParallel: 1, timeoutMs: 3000 };
register("cli-success", "cli-agent", "success", normalBudget);
register("protocol-success", "protocol-agent", "success", normalBudget);
register("forbidden-tool", "cli-agent", "forbidden", normalBudget);
register("call-budget", "cli-agent", "call-budget", { maxCalls: 2, maxIterations: 3, maxParallel: 1, timeoutMs: 3000 });
register("iteration-budget", "cli-agent", "iteration-budget", { maxCalls: 1, maxIterations: 1, maxParallel: 1, timeoutMs: 3000 }, []);
register("timeout-budget", "cli-agent", "timeout", { maxCalls: 1, maxIterations: 1, maxParallel: 1, timeoutMs: 150 }, []);

const engine = new WorkflowEngine({ registry, state, executor: toolExecutor, agents: [cli, protocol] });
async function settle(workflowId: string, key: string) {
  const started = await engine.start(context, { workflowId, revision: "1", input: null, idempotencyKey: key, activationSource });
  for (let i = 0; i < 400; i++) {
    const run = await engine.tick(context, started.runId);
    if (["SUCCEEDED", "FAILED", "BUDGET_EXHAUSTED", "CANCELLED"].includes(run.state)) return run;
    await sleep(10);
  }
  throw new Error("T47_RUN_TIMEOUT:" + workflowId);
}

try {
  await assert.rejects(cli.submit({
    context: { ...context, securityMode: "constrained-host" }, capability: "cli-agent", capabilityVersion: "1", input: null, idempotencyKey: "unsupported-security",
    agentPolicy: { allowedTools: [], maxInternalToolCalls: 0, maxIterations: 0, deadline: Date.now() + 1000 }
  }), (error: unknown) => error instanceof WorkflowError && error.code === "PROVIDER_SECURITY_MODE_UNSUPPORTED");

  const cliRun = await settle("cli-success", "cli-success");
  assert.equal(cliRun.state, "SUCCEEDED");
  assert.equal(cliRun.output, 7);
  assert.equal(cliRun.usedCalls, 2);
  assert.equal(cliRun.usedIterations, 1);
  assert.equal(cliRun.invocations[0]?.provider, "cli-agent");
  assert.equal(cliRun.nodes["main/agent"]?.providerRevision, "1");

  const protocolRun = await settle("protocol-success", "protocol-success");
  assert.equal(protocolRun.state, "SUCCEEDED");
  assert.equal(protocolRun.output, 7);
  assert.equal(protocolRun.usedCalls, 2);
  assert.equal(protocolRun.usedIterations, 1);
  assert.equal(protocolRun.invocations[0]?.provider, "protocol-agent");

  const writesBefore = writeCalls;
  const forbidden = await settle("forbidden-tool", "forbidden");
  assert.equal(forbidden.state, "FAILED");
  assert.equal(writeCalls, writesBefore, "forbidden internal write must never reach the controlled executor");
  const forbiddenNode = forbidden.nodes["main/agent"]!;
  assert.ok(forbiddenNode.executionId);
  const forbiddenSnapshot = await cli.status(context, forbiddenNode.executionId!);
  assert.equal((forbiddenSnapshot.result as Record<string, Json>).code, "AGENT_TOOL_FORBIDDEN");

  const readsBeforeBudget = readCalls;
  const calls = await settle("call-budget", "call-budget");
  assert.equal(calls.state, "BUDGET_EXHAUSTED");
  assert.equal(calls.usedCalls, 2, "one Agent dispatch plus one permitted internal tool consumes the complete call budget");
  assert.equal(readCalls, readsBeforeBudget + 1, "the over-budget second tool request must be rejected before execution");
  const readsAtStop = readCalls;
  await sleep(100);
  assert.equal(readCalls, readsAtStop, "budget stop must not allow late internal tool execution");

  const iterations = await settle("iteration-budget", "iteration-budget");
  assert.equal(iterations.state, "BUDGET_EXHAUSTED");
  assert.equal(iterations.usedIterations, 1);

  const timeoutStart = Date.now();
  const timeout = await settle("timeout-budget", "timeout-budget");
  assert.equal(timeout.state, "BUDGET_EXHAUSTED");
  assert.ok(Date.now() - timeoutStart < 2000, "provider timeout must stop within the platform deadline envelope");

  assert.ok(narrowedAuthorityChecks >= 3, "both provider transports and budgeted calls use the narrowed Workflow authority");
  assert.equal(writeCalls, 0, "Agent approval claims never grant write authority");

  console.log("V3_T47_AGENT_PROVIDERS_OK (real CLI+IPC providers, unified durable session/result, platform-held call/iteration/timeout budgets, mediated internal tools, no self-approval)");
} finally {
  cli.close();
  protocol.close();
  state.close();
  rmSync(fixture, { recursive: true, force: true });
}
