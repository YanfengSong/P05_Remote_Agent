import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDurableKernel, DurableStore, type Run } from '../v3/durable/index.js';
import { CallbackAgentProvider, WorkflowEngine, WorkflowRegistry, copy, type ControlledExecutor, type ExecutionSnapshot, type Json, type Node, type Schema, type SkillDefinition, type StateBackend, type WorkflowContext, type WorkflowDefinition } from '../v3/workflows/index.js';

class SqliteState implements StateBackend {
  readonly db: DatabaseSync;
  constructor(file: string) { this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(namespace TEXT,key TEXT,version INTEGER,value TEXT,PRIMARY KEY(namespace,key))'); }
  async read(namespace: string, key: string) { const row = this.db.prepare('SELECT version,value FROM entries WHERE namespace=? AND key=?').get(namespace, key); return row ? { version: Number(row.version), value: JSON.parse(String(row.value)) as Json } : undefined; }
  async compareAndSet(namespace: string, key: string, version: number | null, value: Json) { return Boolean(version === null ? this.db.prepare('INSERT OR IGNORE INTO entries VALUES(?,?,1,?)').run(namespace, key, JSON.stringify(value)).changes : this.db.prepare('UPDATE entries SET value=?,version=version+1 WHERE namespace=? AND key=? AND version=?').run(JSON.stringify(value), namespace, key, version).changes); }
  close() { this.db.close(); }
}
const dir = await mkdtemp(join(tmpdir(), 'p05-workflow-'));
const context: WorkflowContext = { principal: 'alice', slotId: 'A', hostId: 'host', workspaceId: 'workspace', workspaceRoot: dir, authorizationRevision: '1', authority: ['Read', 'WorkspaceWrite'], securityMode: 'trusted-host' };
const scope = { workspaceId: 'workspace', authority: ['Read', 'WorkspaceWrite'], securityMode: 'trusted-host' as const };
const budget = { maxCalls: 20, maxIterations: 10, maxParallel: 4, timeoutMs: 60000 };
const number: Schema = { type: 'number', minimum: 0, maximum: 100 };
const truth = { op: 'eq' as const, left: { literal: true }, right: { literal: true } };
const dod = [{ id: 'result-contract', condition: truth, evidence: { ref: 'last' as const } }];
const activationSource = { source: 'explicit' as const, reason: 'local validation' };
function skill(id: string, body: Node, capabilities: string[], inputSchema: Schema = number, outputSchema: Schema = number): SkillDefinition { return { skillId: id, revision: '1', description: id, source: 'test-fixture', owner: 'maintainer', objective: id, scope, budget, inputSchema, outputSchema, body, requiredCapabilities: capabilities.map(capability => ({ capability, version: '1' })), agentRequirements: [], dod, stopConditions: [] }; }
function workflow(id: string, skillId: string, inputSchema: Schema = number, outputSchema: Schema = number): WorkflowDefinition { return { workflowId: id, revision: '1', description: id, scope, budget, inputSchema, outputSchema, entryStage: 'main', stages: [{ stageId: 'main', skillId, skillRevision: '1' }], dod }; }
const registry = new WorkflowRegistry({ capabilities: [{ capability: 'baseline', version: '1', effect: 'read' }, { capability: 'edit', version: '1', effect: 'write' }, { capability: 'increment', version: '1', effect: 'read' }], agents: [{ providerId: 'reviewer', revision: '1', effect: 'read' }] });
registry.registerSkill(skill('baseline', { id: 'capture', kind: 'capability', capability: 'baseline', input: { ref: 'input' } }, ['baseline']));
registry.registerSkill(skill('edit', { id: 'change', kind: 'capability', capability: 'edit', input: { ref: 'input' } }, ['edit']));
registry.registerSkill({ ...skill('review', { id: 'review', kind: 'agent', provider: 'reviewer', input: { ref: 'input' } }, []), scope: { ...scope, authority: ['Read'] }, agentRequirements: ['reviewer'] });
registry.registerRoute({ routeId: 'to-edit', revision: '1', fromStage: 'baseline', toStage: 'edit', targetSkillId: 'edit', targetSkillRevision: '1', reason: 'baseline captured' });
registry.registerRoute({ routeId: 'to-review', revision: '1', fromStage: 'edit', toStage: 'review', targetSkillId: 'review', targetSkillRevision: '1', reason: 'change completed' });
const definition: WorkflowDefinition = { ...workflow('engineering', 'baseline'), entryStage: 'baseline', stages: [{ stageId: 'baseline', skillId: 'baseline', skillRevision: '1', next: { routeId: 'to-edit', revision: '1' } }, { stageId: 'edit', skillId: 'edit', skillRevision: '1', next: { routeId: 'to-review', revision: '1' } }, { stageId: 'review', skillId: 'review', skillRevision: '1' }] };
registry.registerWorkflow(definition);
let state = new SqliteState(join(dir, 'workflow.sqlite'));
let durable = createDurableKernel({ store: new DurableStore(join(dir, 'execution.sqlite')), authorize: run => run.capability === 'edit' ? { decision: 'CONFIRM', reason: 'approve edit', expiresAt: Date.now() + 60000 } : { decision: 'ALLOW' }, revalidate: () => true });
let edits = 0, reviews = 0;
const register = () => {
  durable.kernel.register({ capability: 'baseline', capabilityVersion: '1', bindingVersion: '1', execute: async ({ input }) => input });
  durable.kernel.register({ capability: 'increment', capabilityVersion: '1', bindingVersion: '1', execute: async ({ input }) => Number(input) + 1 });
  durable.kernel.register({ capability: 'edit', capabilityVersion: '1', bindingVersion: '1', execute: async ({ input }) => { edits++; await appendFile(join(dir, 'change.txt'), 'changed\n'); return Number(input) + 1; } });
};
register();
const snapshot = (r: Run): ExecutionSnapshot => ({ executionId: r.executionId, state: r.state, result: r.result });
const executor: ControlledExecutor = {
  submit: async request => snapshot(durable.kernel.submit({ principal: request.context.principal, slotId: request.context.slotId, hostId: request.context.hostId, workspaceId: request.context.workspaceId, workspaceRoot: request.context.workspaceRoot, authorizationRevision: request.context.authorizationRevision }, { capability: request.capability, input: request.input, idempotencyKey: request.idempotencyKey })),
  status: async (owner, id) => snapshot(durable.kernel.status(owner, id)),
  cancel: async (owner, id) => snapshot(durable.kernel.cancel(owner, id)),
};
let agent = new CallbackAgentProvider({ providerId: 'reviewer', revision: '1', state, execute: async request => { assert.deepEqual(request.context.authority, ['Read']); reviews++; return request.input; } });
let engine = new WorkflowEngine({ registry, state, executor, agents: [agent] });
const pump = async (id: string, expected: string) => { for (let i = 0; i < 100; i++) { const r = await engine.tick(context, id); if (r.state === expected) return r; if (['FAILED', 'BUDGET_EXHAUSTED', 'CANCELLED'].includes(r.state)) throw new Error(`Unexpected ${r.state}/${r.failureCode}`); await sleep(5); } throw new Error('Workflow failed to settle'); };
try {
  const started = await engine.start(context, { workflowId: 'engineering', revision: '1', input: 1, idempotencyKey: 'three-stage', activationSource });
  assert.equal((await engine.start(context, { workflowId: 'engineering', revision: '1', input: 1, idempotencyKey: 'three-stage', activationSource })).runId, started.runId);
  await assert.rejects(engine.start(context, { workflowId: 'engineering', revision: '1', input: 2, idempotencyKey: 'three-stage', activationSource }), /different intent/);
  await assert.rejects(engine.status({ principal: 'bob', slotId: 'A' }, started.runId), /not found/);
  const waiting = await pump(started.runId, 'WAITING_APPROVAL');
  assert.equal(waiting.activeStage, 'edit'); assert.equal(reviews, 0); assert.equal(edits, 0);
  assert.equal(waiting.invocations.length, 2);
  const waitingVersion = waiting.stateVersion;
  assert.equal((await engine.tick(context, started.runId)).stateVersion, waitingVersion, 'unchanged approval polling must not grow the durable event log');
  const executionId = waiting.invocations.at(-1)!.executionId!;
  agent.close(); await durable.kernel.close(); state.close();
  state = new SqliteState(join(dir, 'workflow.sqlite'));
  durable = createDurableKernel({ store: new DurableStore(join(dir, 'execution.sqlite')), authorize: () => ({ decision: 'ALLOW' }), revalidate: () => true }); register();
  agent = new CallbackAgentProvider({ providerId: 'reviewer', revision: '1', state, execute: async request => { reviews++; assert.deepEqual(request.context.authority, ['Read']); return request.input; } });
  // Revisions remain immutable and an already-started Run retains its persisted original definition.
  registry.registerSkill({ ...skill('baseline', { id: 'capture', kind: 'capability', capability: 'baseline', input: { literal: 99 } }, ['baseline']), revision: '2' });
  assert.throws(() => registry.registerSkill({ ...skill('baseline', { id: 'capture', kind: 'capability', capability: 'baseline', input: { literal: 99 } }, ['baseline']) }), /new revision/);
  engine = new WorkflowEngine({ registry, state, executor, agents: [agent] });
  assert.equal((await engine.tick(context, started.runId)).state, 'WAITING_APPROVAL');
  const approval = durable.kernel.status(context, executionId).approval!;
  durable.operator.decide({ approvalId: approval.approvalId, expectedDecisionVersion: approval.decisionVersion, decision: 'APPROVE', actor: 'local-operator' });
  const completed = await pump(started.runId, 'SUCCEEDED');
  assert.equal(completed.output, 2); assert.equal(completed.invocations.length, 3); assert.equal(edits, 1); assert.equal(reviews, 1);
  assert.equal(completed.handoffs.length, 2); assert.equal(completed.definitionDigest, started.definitionDigest);
  assert.equal(await readFile(join(dir, 'change.txt'), 'utf8'), 'changed\n');

  // A loop consumes actual previous output; conditions never evaluate arbitrary source text.
  registry.registerSkill(skill('loop', { id: 'loop', kind: 'bounded-loop', maxIterations: 3, until: { op: 'gte', left: { ref: 'last' }, right: { literal: 3 } }, body: { id: 'increment', kind: 'capability', capability: 'increment', input: { ref: 'last' } } }, ['increment']));
  registry.registerWorkflow(workflow('loop', 'loop'));
  const loop = await engine.start(context, { workflowId: 'loop', revision: '1', input: 0, idempotencyKey: 'loop', activationSource });
  const loopDone = await pump(loop.runId, 'SUCCEEDED'); assert.equal(loopDone.output, 3); assert.equal(loopDone.usedIterations, 3); assert.equal(loopDone.usedCalls, 3);

  const paired: Schema = { type: 'object', properties: { left: number, right: number }, required: ['left', 'right'], additionalProperties: false };
  registry.registerSkill(skill('parallel', { id: 'sequence', kind: 'sequence', steps: [{ id: 'fork', kind: 'parallel', failurePolicy: 'cancel-siblings', branches: ['left', 'right'].map(key => ({ key, outputOwner: key, authority: ['Read'], node: { id: key, kind: 'capability' as const, capability: 'increment', input: { ref: 'input' as const } } })) }, { id: 'join', kind: 'join', branches: ['left', 'right'] }, { id: 'check', kind: 'verify', condition: { op: 'eq', left: { ref: 'last', path: ['left'] }, right: { ref: 'last', path: ['right'] } }, evidence: { ref: 'last' } }] }, ['increment'], number, paired));
  registry.registerWorkflow(workflow('parallel', 'parallel', number, paired));
  const parallel = await engine.start(context, { workflowId: 'parallel', revision: '1', input: 4, idempotencyKey: 'parallel', activationSource });
  const parallelDone = await pump(parallel.runId, 'SUCCEEDED'); assert.deepEqual(parallelDone.output, { left: 5, right: 5 });
  assert.throws(() => registry.registerSkill(skill('missing', { id: 'missing', kind: 'capability', capability: 'missing', input: { ref: 'input' } }, ['missing'])), /MISSING_CAPABILITY/);
  assert.throws(() => registry.registerSkill({ ...skill('missing-dod', { id: 'read', kind: 'capability', capability: 'baseline', input: { ref: 'input' } }, ['baseline']), dod: [] }), /INVALID_DEFINITION/);
  assert.throws(() => registry.registerWorkflow({ ...workflow('bad-route', 'baseline'), stages: [{ stageId: 'main', skillId: 'baseline', skillRevision: '1', next: { routeId: 'unregistered', revision: '1' } }] }), /INVALID_HANDOFF/);
  assert.throws(() => registry.registerSkill(skill('unsafe-parallel', { id: 'p', kind: 'parallel', failurePolicy: 'wait-all', branches: ['a', 'b'].map(key => ({ key, outputOwner: key, authority: ['WorkspaceWrite'], node: { id: key, kind: 'capability' as const, capability: 'edit', input: { ref: 'input' as const } } })) }, ['edit'])), /PARALLEL_WRITE_ISOLATION_REQUIRED/);
  assert.throws(() => registry.registerSkill({ ...skill('read-only-write', { id: 'write', kind: 'capability', capability: 'edit', input: { ref: 'input' } }, ['edit']), scope: { ...scope, authority: ['Read'] } }), /SCOPE_ESCALATION/);
  assert.throws(() => registry.registerSkill(skill('empty-branch-scope', { id: 'p', kind: 'parallel', failurePolicy: 'wait-all', branches: ['a', 'b'].map(key => ({ key, outputOwner: key, authority: [], node: { id: key, kind: 'capability' as const, capability: 'baseline', input: { ref: 'input' as const } } })) }, ['baseline'])), /SCOPE_ESCALATION/);

  // Unknown external execution is polled by its original ID and never resubmitted.
  let submissions = 0, cancelCalls = 0, safeRetry = false;
  const fake: ControlledExecutor = { submit: async () => { submissions++; return { executionId: 'uncertain', state: 'UNKNOWN' }; }, status: async () => ({ executionId: 'uncertain', state: 'UNKNOWN' }), cancel: async () => { cancelCalls++; return { executionId: 'uncertain', state: 'UNKNOWN' }; } };
  let fakeEngine = new WorkflowEngine({ registry, state, executor: fake, agents: [agent] });
  const unknown = await fakeEngine.start(context, { workflowId: 'loop', revision: '1', input: 0, idempotencyKey: 'unknown', activationSource });
  assert.equal((await fakeEngine.tick(context, unknown.runId)).state, 'PAUSED_UNKNOWN');
  fakeEngine = new WorkflowEngine({ registry, state, executor: fake, agents: [agent] });
  assert.equal((await fakeEngine.tick(context, unknown.runId)).state, 'PAUSED_UNKNOWN'); assert.equal(submissions, 1);
  assert.equal((await fakeEngine.cancel(context, unknown.runId)).state, 'CANCEL_REQUESTED'); assert.equal(cancelCalls, 1);

  registry.registerSkill(skill('retry', { id: 'retry', kind: 'capability', capability: 'baseline', input: { ref: 'input' }, maxAttempts: 2 }, ['baseline'])); registry.registerWorkflow(workflow('retry', 'retry'));
  const retrying: ControlledExecutor = { submit: async request => ({ executionId: request.idempotencyKey, state: request.idempotencyKey.endsWith(':1') ? 'FAILED' : 'SUCCEEDED', result: 7, safeRetry }), status: async () => { throw new Error('unexpected'); }, cancel: async () => { throw new Error('unexpected'); } };
  const retryEngine = new WorkflowEngine({ registry, state, executor: retrying });
  const noRetry = await retryEngine.start(context, { workflowId: 'retry', revision: '1', input: 1, idempotencyKey: 'unsafe-retry', activationSource });
  assert.equal((await retryEngine.tick(context, noRetry.runId)).state, 'FAILED'); assert.equal((await retryEngine.status(context, noRetry.runId)).usedCalls, 1);
  safeRetry = true;
  const retry = await retryEngine.start(context, { workflowId: 'retry', revision: '1', input: 1, idempotencyKey: 'safe-retry', activationSource });
  await retryEngine.tick(context, retry.runId); assert.equal((await retryEngine.tick(context, retry.runId)).state, 'SUCCEEDED');
  assert.equal((await retryEngine.status(context, retry.runId)).invocations.length, 2);

  registry.registerSkill(skill('condition', { id: 'choose', kind: 'condition', when: { op: 'eq', left: { ref: 'input' }, right: { literal: 1 } }, then: { id: 'selected', kind: 'capability', capability: 'baseline', input: { literal: 10 } }, otherwise: { id: 'inactive', kind: 'capability', capability: 'edit', input: { literal: 20 } } }, ['baseline', 'edit']));
  registry.registerWorkflow(workflow('condition', 'condition'));
  const conditionRun = await engine.start(context, { workflowId: 'condition', revision: '1', input: 1, idempotencyKey: 'condition', activationSource });
  const conditionDone = await pump(conditionRun.runId, 'SUCCEEDED'); assert.equal(conditionDone.output, 10); assert.equal(conditionDone.invocations.length, 1); assert.equal(edits, 1);

  registry.registerWorkflow({ ...workflow('budget', 'loop'), budget: { ...budget, maxCalls: 1 } });
  const budgetRun = await engine.start(context, { workflowId: 'budget', revision: '1', input: 0, idempotencyKey: 'budget', activationSource });
  let budgetState = await engine.tick(context, budgetRun.runId);
  for (let i = 0; budgetState.state !== 'BUDGET_EXHAUSTED' && i < 100; i++) { await sleep(5); budgetState = await engine.tick(context, budgetRun.runId); }
  assert.equal(budgetState.state, 'BUDGET_EXHAUSTED'); assert.equal(budgetState.usedCalls, 1);

  let wallTime = 1000;
  const timed = new WorkflowEngine({ registry, state, executor, clock: () => wallTime });
  const deadline = await timed.start(context, { workflowId: 'condition', revision: '1', input: 1, idempotencyKey: 'deadline', activationSource });
  wallTime += budget.timeoutMs;
  assert.equal((await timed.tick(context, deadline.runId)).state, 'BUDGET_EXHAUSTED'); assert.equal((await timed.status(context, deadline.runId)).usedCalls, 0);

  // Callback providers preserve the boundary between durable state and nonresumable in-memory code.
  let releaseCallback: ((value: Json) => void) | undefined, callbackStarts = 0;
  const pendingProvider = new CallbackAgentProvider({ providerId: 'pending-agent', revision: '1', state, execute: async () => { callbackStarts++; return new Promise<Json>(resolve => { releaseCallback = resolve; }); } });
  const pendingAgent = await pendingProvider.submit({ context, capability: 'pending-agent', capabilityVersion: '1', input: null, idempotencyKey: 'pending-agent' });
  for (let i = 0; !releaseCallback && i < 100; i++) await sleep(2);
  pendingProvider.close();
  const restoredProvider = new CallbackAgentProvider({ providerId: 'pending-agent', revision: '1', state, execute: async () => { callbackStarts++; return null; } });
  assert.equal((await restoredProvider.status(context, pendingAgent.executionId)).state, 'UNKNOWN');
  releaseCallback!(5); await sleep(5);
  assert.equal((await restoredProvider.status(context, pendingAgent.executionId)).state, 'UNKNOWN'); assert.equal(callbackStarts, 1); restoredProvider.close();

  let releaseRace: ((value: Json) => void) | undefined, raceReads = 0, raceEnabled = false;
  const raceState: StateBackend = { compareAndSet: (...args) => state.compareAndSet(...args), read: async (namespace, key) => {
    if (raceEnabled && ++raceReads === 2) { releaseRace!(9); await sleep(5); }
    return state.read(namespace, key);
  } };
  const raceProvider = new CallbackAgentProvider({ providerId: 'race-agent', revision: '1', state: raceState, execute: () => new Promise<Json>(resolve => { releaseRace = resolve; }) });
  const raceAgent = await raceProvider.submit({ context, capability: 'race-agent', capabilityVersion: '1', input: null, idempotencyKey: 'race' });
  for (let i = 0; !releaseRace && i < 100; i++) await sleep(2);
  raceEnabled = true;
  assert.equal((await raceProvider.cancel(context, raceAgent.executionId)).state, 'SUCCEEDED');
  assert.equal((await raceProvider.status(context, raceAgent.executionId)).state, 'SUCCEEDED'); raceProvider.close();

  console.log('v3-workflows: three-stage approval/restart, pinned definitions, bounded loop, parallel/join, ownership, unknown/cancel, and safe retries passed');
} finally { agent.close(); await durable.kernel.close(); state.close(); await rm(dir, { recursive: true, force: true }); }
