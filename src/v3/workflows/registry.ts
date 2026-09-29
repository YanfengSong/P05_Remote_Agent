import { createHash } from 'node:crypto';
import { WorkflowError, type Budget, type Condition, type DefinitionSnapshot, type Json, type Node, type RouteDefinition, type Schema, type Scope, type SkillDefinition, type Value, type WorkflowDefinition } from './types.js';

export function json(value: unknown, depth = 0): string {
  if (depth > 64) throw new WorkflowError('INVALID_JSON', 'JSON is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => json(v, depth + 1)).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + json((value as Record<string, unknown>)[k], depth + 1)).join(',') + '}';
  throw new WorkflowError('INVALID_JSON', 'Only finite plain JSON is supported');
}
export function copy<T>(value: T): T { const s = json(value); if (Buffer.byteLength(s) > 4 * 1024 * 1024) throw new WorkflowError('STATE_LIMIT', 'Workflow JSON exceeds 4 MiB'); return JSON.parse(s) as T; }
export function digest(value: unknown): string { return createHash('sha256').update(json(value)).digest('hex'); }
export const refKey = (id: string, revision: string): string => `${id}@${revision}`;
function requireThat(condition: unknown, code = 'INVALID_DEFINITION'): asserts condition { if (!condition) throw new WorkflowError(code, code); }
function label(value: unknown): asserts value is string { requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)); }
function text(value: unknown): asserts value is string { requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096); }
function integer(value: unknown, maximum: number, minimum = 1): asserts value is number { requireThat(Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum); }
function scope(s: Scope): void { requireThat(s && typeof s === 'object'); label(s.workspaceId); requireThat(Array.isArray(s.authority) && s.authority.length <= 32); s.authority.forEach(label); requireThat(['trusted-host', 'constrained-host', 'isolated-worker'].includes(s.securityMode)); }
function budget(b: Budget): void { requireThat(b && typeof b === 'object'); integer(b.maxCalls, 1000); integer(b.maxIterations, 1000); integer(b.maxParallel, 8); integer(b.timeoutMs, 24 * 60 * 60 * 1000); }
export function assertSchema(s: Schema, depth = 0): void {
  requireThat(s && typeof s === 'object' && depth <= 16);
  switch (s.type) {
    case 'null': case 'boolean': return;
    case 'string': integer(s.maxLength, 1024 * 1024, 0); if (s.enum) { requireThat(Array.isArray(s.enum) && s.enum.length <= 100); s.enum.forEach(v => requireThat(typeof v === 'string' && v.length <= s.maxLength)); } return;
    case 'number': if (s.minimum !== undefined) requireThat(Number.isFinite(s.minimum)); if (s.maximum !== undefined) requireThat(Number.isFinite(s.maximum)); requireThat(s.minimum === undefined || s.maximum === undefined || s.minimum <= s.maximum); return;
    case 'array': integer(s.maxItems, 1000, 0); assertSchema(s.items, depth + 1); return;
    case 'object': requireThat(s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) && Object.keys(s.properties).length <= 100 && Array.isArray(s.required) && s.additionalProperties === false); for (const [key, value] of Object.entries(s.properties)) { label(key); assertSchema(value, depth + 1); } s.required.forEach(k => requireThat(Object.hasOwn(s.properties, k))); return;
    default: throw new WorkflowError('INVALID_SCHEMA', 'Unsupported schema');
  }
}
export function validate(schema: Schema, value: Json): void {
  let valid = false;
  switch (schema.type) {
    case 'null': valid = value === null; break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'number': valid = typeof value === 'number' && Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum); break;
    case 'string': valid = typeof value === 'string' && value.length <= schema.maxLength && (!schema.enum || schema.enum.includes(value)); break;
    case 'array': if (Array.isArray(value) && value.length <= schema.maxItems) { value.forEach(v => validate(schema.items, v)); valid = true; } break;
    case 'object': if (value !== null && typeof value === 'object' && !Array.isArray(value)) { valid = schema.required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(schema.properties, k)); if (valid) for (const [k, v] of Object.entries(value)) validate(schema.properties[k], v); } break;
  }
  if (!valid) throw new WorkflowError('SCHEMA_MISMATCH', 'Value does not satisfy the declared contract');
}
function value(v: Value): void { requireThat(v && typeof v === 'object'); if ('literal' in v) { requireThat(Object.keys(v).length === 1); json(v.literal); } else { requireThat(['input', 'last', 'iteration', 'results'].includes(v.ref)); if (v.path) { requireThat(Array.isArray(v.path) && v.path.length <= 16); v.path.forEach(p => { label(p); requireThat(!['__proto__', 'prototype', 'constructor'].includes(p)); }); } requireThat(Object.keys(v).every(k => ['ref', 'path'].includes(k))); } }
function condition(c: Condition, depth = 0): void { requireThat(c && typeof c === 'object' && depth <= 16); if (c.op === 'and' || c.op === 'or') { requireThat(Array.isArray(c.conditions) && c.conditions.length > 0 && c.conditions.length <= 32); c.conditions.forEach(x => condition(x, depth + 1)); } else if (c.op === 'not') condition(c.condition, depth + 1); else { requireThat(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(c.op) && 'left' in c && 'right' in c); value(c.left); value(c.right); } }
export interface Environment { input: Json; last: Json; iteration: number; results: Json }
export function resolve(v: Value, env: Environment): Json {
  if ('literal' in v) return copy(v.literal);
  let result: Json = env[v.ref];
  for (const key of v.path ?? []) { if (result === null || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new WorkflowError('MISSING_REFERENCE', 'Declared input/result reference is unavailable'); result = (result as Record<string, Json>)[key]; }
  return copy(result);
}
export function evaluate(c: Condition, env: Environment): boolean {
  if (c.op === 'and') return c.conditions.every(x => evaluate(x, env));
  if (c.op === 'or') return c.conditions.some(x => evaluate(x, env));
  if (c.op === 'not') return !evaluate(c.condition, env);
  if (!('left' in c)) throw new WorkflowError('INVALID_CONDITION', 'Unsupported condition');
  const a = resolve(c.left, env), b = resolve(c.right, env);
  if (c.op === 'eq') return json(a) === json(b);
  if (c.op === 'ne') return json(a) !== json(b);
  if (typeof a !== 'number' || typeof b !== 'number') throw new WorkflowError('CONDITION_TYPE', 'Ordered comparisons require numbers');
  return c.op === 'lt' ? a < b : c.op === 'lte' ? a <= b : c.op === 'gt' ? a > b : a >= b;
}

export class WorkflowRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly routes = new Map<string, RouteDefinition>();
  private readonly revoked = new Set<string>();
  constructor(private readonly dependencies: { capabilities: { capability: string; version: string; effect: 'read' | 'write' }[]; agents?: { providerId: string; revision: string; effect: 'read' | 'write' }[] }) {}
  registerSkill(definition: SkillDefinition): string {
    const d = copy(definition); label(d.skillId); label(d.revision); [d.description, d.source, d.owner, d.objective].forEach(text); scope(d.scope); budget(d.budget); assertSchema(d.inputSchema); assertSchema(d.outputSchema);
    requireThat(Array.isArray(d.requiredCapabilities) && d.requiredCapabilities.length <= 128 && Array.isArray(d.agentRequirements) && d.agentRequirements.length <= 32);
    for (const c of d.requiredCapabilities) { label(c.capability); label(c.version); requireThat(this.dependencies.capabilities.some(a => a.capability === c.capability && a.version === c.version), 'MISSING_CAPABILITY'); }
    for (const p of d.agentRequirements) { label(p); requireThat(this.dependencies.agents?.some(a => a.providerId === p), 'MISSING_AGENT_PROVIDER'); }
    requireThat(Array.isArray(d.dod) && d.dod.length > 0 && d.dod.length <= 32 && Array.isArray(d.stopConditions) && d.stopConditions.length <= 32);
    for (const rule of d.dod) { label(rule.id); condition(rule.condition); value(rule.evidence); } d.stopConditions.forEach(c => condition(c));
    const ids = new Set<string>();
    requireThat(new Set(d.requiredCapabilities.map(c => c.capability)).size === d.requiredCapabilities.length, 'DUPLICATE_CAPABILITY');
    const check = (node: Node, parallel = false, depth = 0, authority = d.scope.authority): void => {
      requireThat(node && typeof node === 'object' && depth <= 24 && ids.size < 512); label(node.id); requireThat(!ids.has(node.id), 'DUPLICATE_NODE'); ids.add(node.id);
      switch (node.kind) {
        case 'capability': { label(node.capability); value(node.input); integer(node.maxAttempts ?? 1, 3); const dependency = d.requiredCapabilities.find(c => c.capability === node.capability); requireThat(dependency, 'UNDECLARED_CAPABILITY'); const effect = this.dependencies.capabilities.find(c => c.capability === node.capability && c.version === dependency.version)!.effect; if (parallel) requireThat(effect === 'read', 'PARALLEL_WRITE_ISOLATION_REQUIRED'); requireThat(authority.includes(effect === 'write' ? 'WorkspaceWrite' : 'Read'), 'SCOPE_ESCALATION'); break; }
        case 'agent': { label(node.provider); value(node.input); integer(node.maxAttempts ?? 1, 3); requireThat(d.agentRequirements.includes(node.provider), 'UNDECLARED_AGENT'); const effect = this.dependencies.agents!.find(p => p.providerId === node.provider)!.effect; if (parallel) requireThat(effect === 'read', 'PARALLEL_WRITE_ISOLATION_REQUIRED'); requireThat(authority.includes(effect === 'write' ? 'WorkspaceWrite' : 'Read'), 'SCOPE_ESCALATION'); break; }
        case 'sequence': requireThat(Array.isArray(node.steps) && node.steps.length > 0 && node.steps.length <= 64); node.steps.forEach(n => check(n, parallel, depth + 1, authority)); break;
        case 'condition': condition(node.when); check(node.then, parallel, depth + 1, authority); check(node.otherwise, parallel, depth + 1, authority); break;
        case 'bounded-loop': integer(node.maxIterations, Math.min(100, d.budget.maxIterations)); condition(node.until); check(node.body, parallel, depth + 1, authority); break;
        case 'parallel': {
          requireThat(Array.isArray(node.branches) && node.branches.length >= 2 && node.branches.length <= d.budget.maxParallel && ['cancel-siblings', 'wait-all'].includes(node.failurePolicy));
          const owners = new Set<string>(), keys = new Set<string>();
          for (const b of node.branches) { label(b.key); label(b.outputOwner); requireThat(!owners.has(b.outputOwner) && !keys.has(b.key), 'PARALLEL_OUTPUT_CONFLICT'); owners.add(b.outputOwner); keys.add(b.key); requireThat(Array.isArray(b.authority) && b.authority.every(a => authority.includes(a)), 'SCOPE_ESCALATION'); check(b.node, true, depth + 1, b.authority); }
          break;
        }
        case 'join': requireThat(Array.isArray(node.branches) && node.branches.length > 0 && node.branches.length <= 8); node.branches.forEach(label); break;
        case 'verify': condition(node.condition); value(node.evidence); break;
        default: throw new WorkflowError('UNSUPPORTED_NODE', 'Node is not part of the finite IR');
      }
    };
    check(d.body); return this.insert(this.skills, refKey(d.skillId, d.revision), d);
  }
  registerRoute(route: RouteDefinition): string { const r = copy(route); [r.routeId, r.revision, r.fromStage, r.toStage, r.targetSkillId, r.targetSkillRevision].forEach(label); text(r.reason); requireThat(this.skills.has(refKey(r.targetSkillId, r.targetSkillRevision)), 'MISSING_TARGET_SKILL'); return this.insert(this.routes, refKey(r.routeId, r.revision), r); }
  registerWorkflow(definition: WorkflowDefinition): string {
    const d = copy(definition); label(d.workflowId); label(d.revision); text(d.description); scope(d.scope); budget(d.budget); assertSchema(d.inputSchema); assertSchema(d.outputSchema); label(d.entryStage);
    requireThat(Array.isArray(d.stages) && d.stages.length > 0 && d.stages.length <= 64 && Array.isArray(d.dod) && d.dod.length > 0 && d.dod.length <= 32);
    d.dod.forEach(r => { label(r.id); condition(r.condition); value(r.evidence); });
    const stages = new Map(d.stages.map(s => [s.stageId, s])); requireThat(stages.size === d.stages.length, 'DUPLICATE_STAGE');
    for (const s of d.stages) { label(s.stageId); label(s.skillId); label(s.skillRevision); const skill = this.skills.get(refKey(s.skillId, s.skillRevision)); requireThat(skill, 'MISSING_SKILL'); requireThat(skill.scope.workspaceId === d.scope.workspaceId && skill.scope.securityMode === d.scope.securityMode && skill.scope.authority.every(a => d.scope.authority.includes(a)), 'SCOPE_ESCALATION'); if (s.next) { label(s.next.routeId); label(s.next.revision); const route = this.routes.get(refKey(s.next.routeId, s.next.revision)); const target = route && stages.get(route.toStage); requireThat(route && target && route.fromStage === s.stageId && target.skillId === route.targetSkillId && target.skillRevision === route.targetSkillRevision, 'INVALID_HANDOFF'); } }
    let stage = d.entryStage; const visited = new Set<string>();
    for (;;) { const current = stages.get(stage); requireThat(current && !visited.has(stage), 'UNBOUNDED_STAGE_CYCLE'); visited.add(stage); if (!current.next) break; stage = this.routes.get(refKey(current.next.routeId, current.next.revision))!.toStage; }
    requireThat(visited.size === stages.size, 'UNREACHABLE_STAGE');
    return this.insert(this.workflows, refKey(d.workflowId, d.revision), d);
  }
  deactivateSkill(skillId: string, revision: string): void { this.revoked.add(refKey(skillId, revision)); }
  snapshot(workflowId: string, revision: string): DefinitionSnapshot {
    const workflow = this.workflows.get(refKey(workflowId, revision)); requireThat(workflow, 'WORKFLOW_NOT_REGISTERED');
    const snapshot: DefinitionSnapshot = { workflow, skills: {}, routes: {}, skillDigests: {}, agentRevisions: {} };
    for (const s of workflow.stages) { const key = refKey(s.skillId, s.skillRevision); requireThat(!this.revoked.has(key), 'SKILL_INACTIVE'); snapshot.skills[key] = this.skills.get(key)!; snapshot.skillDigests[key] = digest(snapshot.skills[key]); if (s.next) { const route = refKey(s.next.routeId, s.next.revision); snapshot.routes[route] = this.routes.get(route)!; } }
    for (const skill of Object.values(snapshot.skills)) for (const provider of skill.agentRequirements) snapshot.agentRevisions[provider] = this.dependencies.agents!.find(p => p.providerId === provider)!.revision;
    return copy(snapshot);
  }
  private insert<T>(map: Map<string, T>, key: string, definition: T): string { const existing = map.get(key), hash = digest(definition); if (existing && digest(existing) !== hash) throw new WorkflowError('REVISION_CONFLICT', 'Changing content requires a new revision'); map.set(key, definition); return hash; }
}
