import { WorkflowError, type AgentProvider, type ControlledExecutor, type ExecutionSnapshot, type Json, type Node, type NodeRecord, type Owner, type SkillDefinition, type StartRequest, type StateBackend, type WorkflowContext, type WorkflowRun } from './types.js';
import { copy, digest, evaluate, refKey, resolve, validate, type Environment, WorkflowRegistry } from './registry.js';

const finished = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED']);
const executorFinished = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'DENIED', 'EXPIRED']);
interface Session { run: WorkflowRun; version: number; namespace: string; steps: number; authority: string[]; contentDigest: string }
interface Outcome { state: 'done' | 'waiting' | 'unknown' | 'failed'; output?: Json }
export class WorkflowEngine {
  private readonly now: () => number;
  private readonly agents = new Map<string, AgentProvider>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly options: { registry: WorkflowRegistry; state: StateBackend; executor: ControlledExecutor; agents?: AgentProvider[]; clock?: () => number }) {
    this.now = options.clock ?? Date.now;
    for (const p of options.agents ?? []) { if (this.agents.has(p.providerId)) throw new WorkflowError('DUPLICATE_PROVIDER', 'Provider already installed'); this.agents.set(p.providerId, p); }
  }
  private namespace(owner: Owner): string { return 'workflow:' + digest({ principal: owner.principal, slotId: owner.slotId }); }
  private async owned(owner: Owner, id: string): Promise<Session> {
    const namespace = this.namespace(owner), row = await this.options.state.read(namespace, id);
    if (!row) throw new WorkflowError('NOT_FOUND', 'Workflow not found');
    const run = copy(row.value) as unknown as WorkflowRun;
    if (run.runId !== id || run.context.principal !== owner.principal || run.context.slotId !== owner.slotId) throw new WorkflowError('NOT_FOUND', 'Workflow not found');
    if (digest(run.definition) !== run.definitionDigest) throw new WorkflowError('DEFINITION_INTEGRITY', 'Pinned definition digest changed');
    return { run, version: row.version, namespace, steps: 0, authority: this.skill(run).scope.authority, contentDigest: this.contentDigest(run) };
  }
  async status(owner: Owner, id: string): Promise<WorkflowRun> { return copy((await this.owned(owner, id)).run); }
  async start(context: WorkflowContext, request: StartRequest): Promise<WorkflowRun> {
    if (!request.idempotencyKey || request.idempotencyKey.length > 256 || !['explicit', 'workflow-handoff', 'intent-match'].includes(request.activationSource.source) || !request.activationSource.reason.trim() || request.activationSource.reason.length > 4096) throw new WorkflowError('INVALID_ACTIVATION', 'Explicit activation contract required');
    const definition = this.options.registry.snapshot(request.workflowId, request.revision), workflow = definition.workflow;
    if (workflow.scope.workspaceId !== context.workspaceId || workflow.scope.securityMode !== context.securityMode || !workflow.scope.authority.every(a => context.authority.includes(a))) throw new WorkflowError('SCOPE_ESCALATION', 'Definition exceeds supplied execution scope');
    validate(workflow.inputSchema, request.input);
    const namespace = this.namespace(context), id = 'wf-' + digest({ namespace, key: request.idempotencyKey });
    const intentDigest = digest({ context, request, definitionDigest: digest(definition) });
    const existing = await this.options.state.read(namespace, id);
    if (existing) { const run = await this.status(context, id); if (run.intentDigest !== intentDigest) throw new WorkflowError('IDEMPOTENCY_CONFLICT', 'Workflow key has a different intent'); return run; }
    const stage = workflow.stages.find(s => s.stageId === workflow.entryStage)!;
    const skill = definition.skills[refKey(stage.skillId, stage.skillRevision)]; validate(skill.inputSchema, request.input);
    for (const def of Object.values(definition.skills)) for (const provider of def.agentRequirements) if (this.agents.get(provider)?.revision !== definition.agentRevisions[provider]) throw new WorkflowError('MISSING_AGENT_PROVIDER', 'Pinned agent provider is unavailable');
    const at = this.now();
    const run: WorkflowRun = { runId: id, context: copy(context), definitionDigest: digest(definition), intentDigest, definition, state: 'RUNNING', stateVersion: 1, createdAt: at, deadline: at + workflow.budget.timeoutMs, activeStage: stage.stageId, activation: copy(request.activationSource), activeSkillRevision: stage.skillRevision, usedCalls: 0, usedIterations: 0, stageCalls: 0, stageIterations: 0, stageStartedAt: at, stageInput: copy(request.input), input: copy(request.input), output: null, nodes: {}, stageOutputs: {}, artifactRefs: [], invocations: [], handoffs: [], events: [{ sequence: 1, at, type: 'CREATED', stage: stage.stageId }] };
    if (!await this.options.state.compareAndSet(namespace, id, null, copy(run) as unknown as Json)) { const found = await this.status(context, id); if (found.intentDigest !== intentDigest) throw new WorkflowError('IDEMPOTENCY_CONFLICT', 'Workflow key has a different intent'); return found; }
    return copy(run);
  }
  private serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(id, task); void task.finally(() => { if (this.locks.get(id) === task) this.locks.delete(id); }).catch(() => {});
    return task;
  }
  private async save(session: Session, type: string): Promise<void> {
    const r = session.run;
    const contentDigest = this.contentDigest(r);
    if (contentDigest === session.contentDigest) return;
    const sequence = (r.events.at(-1)?.sequence ?? 0) + 1;
    if (r.events.length >= 2048) r.events.shift();
    r.stateVersion++; r.events.push({ sequence, at: this.now(), type, stage: r.activeStage });
    if (!await this.options.state.compareAndSet(session.namespace, r.runId, session.version, copy(r) as unknown as Json)) throw new WorkflowError('STATE_CONFLICT', 'Workflow writer ownership changed');
    session.version++; session.contentDigest = contentDigest;
  }
  private contentDigest(run: WorkflowRun): string { return digest({ ...run, stateVersion: 0, events: [] }); }
  private skill(run: WorkflowRun): SkillDefinition { const stage = run.definition.workflow.stages.find(s => s.stageId === run.activeStage)!; return run.definition.skills[refKey(stage.skillId, stage.skillRevision)]; }
  private environment(run: WorkflowRun, last: Json = run.stageInput, iteration = 0): Environment { return { input: run.stageInput, last, iteration, results: run.stageOutputs }; }
  private exhausted(run: WorkflowRun, newCall = false, iteration = false): boolean {
    const skill = this.skill(run), budget = run.definition.workflow.budget;
    return this.now() >= run.deadline || this.now() >= run.stageStartedAt + skill.budget.timeoutMs ||
      (newCall && (run.usedCalls >= budget.maxCalls || run.stageCalls >= skill.budget.maxCalls)) ||
      (iteration && (run.usedIterations >= budget.maxIterations || run.stageIterations >= skill.budget.maxIterations));
  }
  async tick(owner: Owner, id: string): Promise<WorkflowRun> { return this.serialized(id, async () => {
    const session = await this.owned(owner, id), r = session.run;
    if (finished.has(r.state)) return copy(r);
    if (r.stopReason) { await this.stop(session); return copy(r); }
    try {
      if (this.exhausted(r)) { r.stopReason = 'BUDGET_EXHAUSTED'; await this.save(session, 'BUDGET_EXHAUSTED'); await this.stop(session); return copy(r); }
      const skill = this.skill(r), env = this.environment(r);
      if (skill.stopConditions.some(c => evaluate(c, env))) throw new WorkflowError('STOP_CONDITION', 'Declared stop condition matched');
      const outcome = await this.node(skill.body, `${r.activeStage}/${skill.body.id}`, env, session);
      if (outcome.state === 'done') {
        const output = outcome.output ?? null, finalEnv = this.environment(r, output);
        validate(skill.outputSchema, output);
        for (const d of skill.dod) { if (!evaluate(d.condition, finalEnv)) throw new WorkflowError('DOD_FAILED', 'Skill completion evidence failed'); resolve(d.evidence, finalEnv); }
        r.stageOutputs[r.activeStage] = output;
        const stage = r.definition.workflow.stages.find(s => s.stageId === r.activeStage)!;
        if (stage.next) {
          const route = r.definition.routes[refKey(stage.next.routeId, stage.next.revision)], target = r.definition.workflow.stages.find(s => s.stageId === route.toStage)!;
          const nextSkill = r.definition.skills[refKey(target.skillId, target.skillRevision)]; validate(nextSkill.inputSchema, output);
          r.handoffs.push({ from: r.activeStage, to: target.stageId, routeId: route.routeId, routeRevision: route.revision, reason: route.reason, at: this.now() });
          r.activeStage = target.stageId; r.activeSkillRevision = target.skillRevision; r.stageInput = output; r.stageCalls = 0; r.stageIterations = 0; r.stageStartedAt = this.now(); r.state = 'RUNNING'; await this.save(session, 'HANDOFF');
        } else {
          validate(r.definition.workflow.outputSchema, output);
          for (const d of r.definition.workflow.dod) { if (!evaluate(d.condition, finalEnv)) throw new WorkflowError('DOD_FAILED', 'Workflow completion evidence failed'); resolve(d.evidence, finalEnv); }
          r.output = output; r.state = 'SUCCEEDED'; await this.save(session, 'SUCCEEDED');
        }
      } else if (outcome.state === 'failed') { r.stopReason = 'STAGE_FAILED'; await this.save(session, 'STAGE_FAILED'); await this.stop(session); }
      else { const pending = Object.values(r.nodes).filter(n => n.state !== 'SUCCEEDED'); r.state = outcome.state === 'unknown' ? 'PAUSED_UNKNOWN' : pending.some(n => n.executorState === 'WAITING_APPROVAL') ? 'WAITING_APPROVAL' : 'WAITING_EXECUTION'; await this.save(session, r.state); }
    } catch (error) {
      if (error instanceof WorkflowError && ['STATE_CONFLICT', 'STATE_LIMIT'].includes(error.code)) throw error;
      r.failureCode = error instanceof WorkflowError ? error.code : 'ORCHESTRATION_ERROR';
      r.stopReason = r.failureCode === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'STAGE_FAILED'; await this.save(session, r.failureCode); await this.stop(session);
    }
    return copy(r);
  }); }
  private async node(node: Node, key: string, env: Environment, session: Session): Promise<Outcome> {
    const r = session.run;
    if (++session.steps > 256) return { state: 'waiting' };
    if (this.exhausted(r)) throw new WorkflowError('BUDGET_EXHAUSTED', 'Deadline exceeded');
    let record = r.nodes[key];
    if (record?.state === 'SUCCEEDED') return { state: 'done', output: record.output ?? null };
    if (record?.state === 'FAILED') return { state: 'failed' };
    if (!record) { record = { key, kind: node.kind, state: 'PLANNED', attempt: 1, artifactRefs: [] }; r.nodes[key] = record; await this.save(session, 'NODE_PLANNED'); }
    const complete = async (output: Json): Promise<Outcome> => { record.state = 'SUCCEEDED'; record.output = copy(output); await this.save(session, 'NODE_SUCCEEDED'); return { state: 'done', output }; };
    switch (node.kind) {
      case 'capability': case 'agent': return this.invoke(node, record, env, session);
      case 'sequence': {
        let last = env.last;
        for (const child of node.steps) { const outcome = await this.node(child, key + '/' + child.id, { ...env, last }, session); if (outcome.state !== 'done') return outcome; last = outcome.output ?? null; }
        return complete(last);
      }
      case 'condition': {
        if (!record.selected) { record.selected = evaluate(node.when, env) ? 'then' : 'otherwise'; await this.save(session, 'CONDITION_SELECTED'); }
        const child = node[record.selected], result = await this.node(child, key + '/' + child.id, env, session);
        return result.state === 'done' ? complete(result.output ?? null) : result;
      }
      case 'verify': if (!evaluate(node.condition, env)) { record.state = 'FAILED'; record.failureCode = 'VERIFICATION_FAILED'; await this.save(session, 'VERIFICATION_FAILED'); return { state: 'failed' }; } return complete(resolve(node.evidence, env));
      case 'join': {
        const branches = env.last;
        if (branches === null || typeof branches !== 'object' || Array.isArray(branches) || !node.branches.every(k => Object.hasOwn(branches, k))) throw new WorkflowError('JOIN_MISSING_BRANCH', 'Join requires declared branch results');
        const output: Record<string, Json> = {}; for (const k of node.branches) output[k] = branches[k]; return complete(output);
      }
      case 'bounded-loop': {
        const i = record.iteration ?? 0;
        let last = env.last;
        if (i > 0) last = r.nodes[`${key}/i${i - 1}/${node.body.id}`]?.output ?? null;
        if (evaluate(node.until, { ...env, last, iteration: i })) return complete(last);
        if (i >= node.maxIterations) throw new WorkflowError('LOOP_LIMIT', 'Loop did not meet its stop condition');
        const childKey = `${key}/i${i}/${node.body.id}`;
        if (!r.nodes[childKey]) { if (this.exhausted(r, false, true)) throw new WorkflowError('BUDGET_EXHAUSTED', 'Iteration budget exhausted'); r.usedIterations++; r.stageIterations++; r.nodes[childKey] = { key: childKey, kind: node.body.kind, state: 'PLANNED', attempt: 1, artifactRefs: [] }; await this.save(session, 'ITERATION_RESERVED'); }
        const result = await this.node(node.body, childKey, { ...env, last, iteration: i }, session);
        if (result.state !== 'done') return result;
        record.iteration = i + 1; await this.save(session, 'ITERATION_COMPLETED');
        return { state: 'waiting' };
      }
      case 'parallel': {
        const output: Record<string, Json> = {}; let waiting = false, unknown = false, failed = false;
        // Submit branches independently without waiting for their external completion; all remain in flight.
        for (const branch of node.branches) {
          if (failed && node.failurePolicy === 'cancel-siblings') break;
          const parentAuthority = session.authority;
          session.authority = parentAuthority.filter(a => branch.authority.includes(a));
          let result: Outcome;
          try { result = await this.node(branch.node, key + '/' + branch.key + '/' + branch.node.id, env, session); }
          finally { session.authority = parentAuthority; }
          if (result.state === 'done') output[branch.key] = result.output ?? null;
          else if (result.state === 'failed') failed = true;
          else if (result.state === 'unknown') unknown = true;
          else waiting = true;
        }
        if (failed && (node.failurePolicy === 'cancel-siblings' || (!waiting && !unknown))) return { state: 'failed' };
        if (unknown) return { state: 'unknown' };
        return waiting ? { state: 'waiting' } : complete(output);
      }
    }
  }
  private executor(record: NodeRecord): ControlledExecutor { if (record.executor === 'agent') { const provider = record.provider && this.agents.get(record.provider); if (!provider || provider.revision !== record.providerRevision) throw new WorkflowError('MISSING_AGENT_PROVIDER', 'Pinned provider unavailable'); return provider; } return this.options.executor; }
  private async invoke(node: Extract<Node, { kind: 'capability' | 'agent' }>, record: NodeRecord, env: Environment, session: Session): Promise<Outcome> {
    const r = session.run;
    if (!record.idempotencyKey) {
      const inFlight = r.invocations.filter(i => !executorFinished.has(i.state)).length;
      if (inFlight >= Math.min(this.skill(r).budget.maxParallel, r.definition.workflow.budget.maxParallel)) return { state: 'waiting' };
      if (this.exhausted(r, true)) throw new WorkflowError('BUDGET_EXHAUSTED', 'Tool call budget exhausted');
      record.idempotencyKey = `${r.runId}:${digest(record.key)}:${record.attempt}`;
      record.executor = node.kind === 'agent' ? 'agent' : 'capability';
      if (node.kind === 'agent') { record.provider = node.provider; record.providerRevision = r.definition.agentRevisions[node.provider]; }
      record.scopeAuthority = [...session.authority];
      record.requestInput ??= resolve(node.input, env);
      r.usedCalls++; r.stageCalls++;
      r.invocations.push({ nodeKey: record.key, attempt: record.attempt, idempotencyKey: record.idempotencyKey, executor: record.executor, ...(record.provider ? { provider: record.provider } : {}), state: 'SUBMIT_INTENT' });
      await this.save(session, 'INVOCATION_INTENT');
    }
    const executor = this.executor(record);
    const context = { ...copy(r.context), authority: record.scopeAuthority! };
    let snapshot: ExecutionSnapshot;
    try {
      if (record.executionId) snapshot = await executor.status(context, record.executionId);
      else {
        const capability = node.kind === 'capability' ? node.capability : node.provider;
        const version = node.kind === 'capability' ? this.skill(r).requiredCapabilities.find(c => c.capability === capability)!.version : record.providerRevision!;
        const skill = this.skill(r);
        const agentPolicy = node.kind === 'agent' ? {
          allowedTools: skill.requiredCapabilities.map(item => ({ capability: item.capability, capabilityVersion: item.version })),
          maxInternalToolCalls: Math.max(0, Math.min(skill.budget.maxCalls - r.stageCalls, r.definition.workflow.budget.maxCalls - r.usedCalls)),
          maxIterations: Math.max(0, Math.min(skill.budget.maxIterations - r.stageIterations, r.definition.workflow.budget.maxIterations - r.usedIterations)),
          deadline: Math.min(r.deadline, r.stageStartedAt + skill.budget.timeoutMs)
        } : undefined;
        snapshot = await executor.submit({ context, capability, capabilityVersion: version, input: copy(record.requestInput!), idempotencyKey: record.idempotencyKey, ...(agentPolicy ? { agentPolicy } : {}) });
      }
    } catch { record.state = record.executionId ? 'WAITING' : 'UNKNOWN'; record.failureCode = 'EXECUTOR_TRANSPORT_UNCONFIRMED'; await this.save(session, 'EXECUTOR_UNCONFIRMED'); return { state: record.executionId ? 'waiting' : 'unknown' }; }
    if (!snapshot.executionId || (record.executionId && snapshot.executionId !== record.executionId)) throw new WorkflowError('EXECUTOR_IDENTITY', 'Execution identity changed');
    record.executionId = snapshot.executionId; record.executorState = snapshot.state;
    const invocation = r.invocations.find(i => i.idempotencyKey === record.idempotencyKey)!; invocation.executionId = snapshot.executionId; invocation.state = snapshot.state;
    if (record.executor === 'agent') {
      const usage = snapshot.usage ?? { internalToolCalls: 0, iterations: 0 };
      if (!Number.isSafeInteger(usage.internalToolCalls) || usage.internalToolCalls < 0 || !Number.isSafeInteger(usage.iterations) || usage.iterations < 0) throw new WorkflowError('PROVIDER_USAGE_INVALID', 'Provider usage is invalid');
      const prior = record.providerUsage ?? { internalToolCalls: 0, iterations: 0 };
      if (usage.internalToolCalls < prior.internalToolCalls || usage.iterations < prior.iterations) throw new WorkflowError('PROVIDER_USAGE_INVALID', 'Provider usage moved backwards');
      const addedCalls = usage.internalToolCalls - prior.internalToolCalls, addedIterations = usage.iterations - prior.iterations;
      const skill = this.skill(r), workflowBudget = r.definition.workflow.budget;
      if (r.usedCalls + addedCalls > workflowBudget.maxCalls || r.stageCalls + addedCalls > skill.budget.maxCalls || r.usedIterations + addedIterations > workflowBudget.maxIterations || r.stageIterations + addedIterations > skill.budget.maxIterations) throw new WorkflowError('PROVIDER_BUDGET_VIOLATION', 'Provider exceeded the platform budget envelope');
      r.usedCalls += addedCalls; r.stageCalls += addedCalls; r.usedIterations += addedIterations; r.stageIterations += addedIterations; record.providerUsage = { ...usage };
      if (snapshot.budgetExhausted) { if (!executorFinished.has(snapshot.state)) throw new WorkflowError('PROVIDER_USAGE_INVALID', 'Budget exhaustion must be terminal'); record.state = 'FAILED'; record.failureCode = 'BUDGET_EXHAUSTED'; throw new WorkflowError('BUDGET_EXHAUSTED', 'Agent provider budget exhausted'); }
    }
    const artifacts = snapshot.artifactRefs ?? [];
    if (artifacts.length > 100 || artifacts.some(a => typeof a !== 'string' || a.length > 2048)) throw new WorkflowError('ARTIFACT_LIMIT', 'Invalid artifact references');
    record.artifactRefs = [...new Set(artifacts)]; r.artifactRefs = [...new Set([...r.artifactRefs, ...artifacts])];
    if (snapshot.state === 'SUCCEEDED') { record.state = 'SUCCEEDED'; record.output = copy(snapshot.result ?? null); await this.save(session, 'INVOCATION_SUCCEEDED'); return { state: 'done', output: record.output }; }
    if (snapshot.state === 'UNKNOWN') { record.state = 'UNKNOWN'; await this.save(session, 'INVOCATION_UNKNOWN'); return { state: 'unknown' }; }
    if (executorFinished.has(snapshot.state)) {
      if (snapshot.state === 'FAILED' && snapshot.safeRetry === true && record.attempt < (node.maxAttempts ?? 1)) {
        record.attempt++; delete record.executionId; delete record.idempotencyKey; record.state = 'PLANNED'; record.safeRetry = true; await this.save(session, 'SAFE_RETRY_RESERVED'); return { state: 'waiting' };
      }
      record.state = 'FAILED'; record.failureCode = 'EXECUTION_' + snapshot.state; await this.save(session, record.failureCode); return { state: 'failed' };
    }
    record.state = 'WAITING'; await this.save(session, 'INVOCATION_WAITING'); return { state: 'waiting' };
  }
  async cancel(owner: Owner, id: string): Promise<WorkflowRun> { return this.serialized(id, async () => {
    const s = await this.owned(owner, id); if (finished.has(s.run.state)) return copy(s.run);
    s.run.stopReason = 'USER_CANCEL'; s.run.state = 'CANCEL_REQUESTED'; await this.save(s, 'CANCEL_REQUESTED'); await this.stop(s); return copy(s.run);
  }); }
  private async stop(s: Session): Promise<void> {
    let uncertain = false;
    for (const invocation of s.run.invocations) {
      if (executorFinished.has(invocation.state)) continue;
      const record = s.run.nodes[invocation.nodeKey];
      const context = { ...copy(s.run.context), authority: record.scopeAuthority! };
      try {
        const executor = this.executor(record);
        if (!invocation.executionId) { const found = await executor.find?.(context, invocation.idempotencyKey); if (!found) { uncertain = true; continue; } invocation.executionId = found.executionId; }
        const snapshot = await executor.cancel(context, invocation.executionId); invocation.state = snapshot.state;
        if (!executorFinished.has(snapshot.state)) uncertain = true;
        record.executorState = snapshot.state; record.state = snapshot.state === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      } catch { uncertain = true; }
    }
    s.run.state = uncertain ? 'CANCEL_REQUESTED' : s.run.stopReason === 'USER_CANCEL' ? 'CANCELLED' : s.run.stopReason === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'FAILED';
    await this.save(s, s.run.state);
  }
}
