export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Owner { principal: string; slotId: string }
export interface WorkflowContext extends Owner {
  hostId: string; workspaceId: string; workspaceRoot: string; authorizationRevision: string;
  authority: string[]; securityMode: 'trusted-host' | 'constrained-host' | 'isolated-worker';
}
export interface Scope { workspaceId: string; authority: string[]; securityMode: WorkflowContext['securityMode'] }
export interface Budget { maxCalls: number; maxIterations: number; maxParallel: number; timeoutMs: number }
export type Schema =
  | { type: 'null' | 'boolean' }
  | { type: 'string'; maxLength: number; enum?: string[] }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'array'; items: Schema; maxItems: number }
  | { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
export type Value = { literal: Json } | { ref: 'input' | 'last' | 'iteration' | 'results'; path?: string[] };
export type Condition = { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; left: Value; right: Value } | { op: 'and' | 'or'; conditions: Condition[] } | { op: 'not'; condition: Condition };
export type Node =
  | { id: string; kind: 'capability'; capability: string; input: Value; maxAttempts?: number }
  | { id: string; kind: 'agent'; provider: string; input: Value; maxAttempts?: number }
  | { id: string; kind: 'sequence'; steps: Node[] }
  | { id: string; kind: 'condition'; when: Condition; then: Node; otherwise: Node }
  | { id: string; kind: 'bounded-loop'; maxIterations: number; until: Condition; body: Node }
  | { id: string; kind: 'parallel'; branches: { key: string; outputOwner: string; authority: string[]; node: Node }[]; failurePolicy: 'cancel-siblings' | 'wait-all' }
  | { id: string; kind: 'join'; branches: string[] }
  | { id: string; kind: 'verify'; condition: Condition; evidence: Value };
export interface SkillDefinition {
  skillId: string; revision: string; description: string; source: string; owner: string;
  objective: string; scope: Scope; inputSchema: Schema; outputSchema: Schema;
  requiredCapabilities: { capability: string; version: string }[]; agentRequirements: string[];
  budget: Budget; body: Node; dod: { id: string; condition: Condition; evidence: Value }[];
  stopConditions: Condition[];
}
export interface RouteDefinition { routeId: string; revision: string; fromStage: string; toStage: string; targetSkillId: string; targetSkillRevision: string; reason: string }
export interface WorkflowDefinition {
  workflowId: string; revision: string; description: string; scope: Scope;
  inputSchema: Schema; outputSchema: Schema; budget: Budget; entryStage: string;
  stages: { stageId: string; skillId: string; skillRevision: string; next?: { routeId: string; revision: string } }[];
  dod: { id: string; condition: Condition; evidence: Value }[];
}
export interface Activation { source: 'explicit' | 'workflow-handoff' | 'intent-match'; reason: string }
export interface AgentPolicy { allowedTools: { capability: string; capabilityVersion: string }[]; maxInternalToolCalls: number; maxIterations: number; deadline: number }
export interface ProviderUsage { internalToolCalls: number; iterations: number }
export interface ExecutionRequest { context: WorkflowContext; capability: string; capabilityVersion: string; input: Json; idempotencyKey: string; agentPolicy?: AgentPolicy }
export interface ExecutionSnapshot {
  executionId: string; state: 'QUEUED' | 'WAITING_APPROVAL' | 'RUNNING' | 'CANCEL_REQUESTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'EXPIRED' | 'CANCELLED' | 'UNKNOWN';
  result?: Json | null; safeRetry?: boolean; artifactRefs?: string[]; usage?: ProviderUsage; budgetExhausted?: boolean;
}
/** submit must durably deduplicate keys before effects; status must enforce context ownership. */
export interface ControlledExecutor {
  submit(request: ExecutionRequest): Promise<ExecutionSnapshot>;
  status(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot>;
  cancel(context: WorkflowContext, executionId: string): Promise<ExecutionSnapshot>;
  /** Optional read-only reconciliation of a submit acknowledged only to a crashed caller. */
  find?(context: WorkflowContext, idempotencyKey: string): Promise<ExecutionSnapshot | undefined>;
}
/** Providers obey the same durable invocation contract; no implicit external CLI integration. */
export interface AgentProvider extends ControlledExecutor { providerId: string; revision: string }
export interface StateBackend {
  read(namespace: string, key: string): Promise<{ version: number; value: Json } | undefined>;
  compareAndSet(namespace: string, key: string, expectedVersion: number | null, value: Json): Promise<boolean>;
}
export interface DefinitionSnapshot { workflow: WorkflowDefinition; skills: Record<string, SkillDefinition>; routes: Record<string, RouteDefinition>; skillDigests: Record<string, string>; agentRevisions: Record<string, string> }
export interface NodeRecord {
  key: string; kind: Node['kind']; state: 'PLANNED' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCEL_REQUESTED' | 'CANCELLED';
  attempt: number; idempotencyKey?: string; executionId?: string; executor?: 'capability' | 'agent'; provider?: string;
  executorState?: ExecutionSnapshot['state']; safeRetry?: boolean; output?: Json; iteration?: number; selected?: 'then' | 'otherwise';
  cursor?: number; artifactRefs: string[]; failureCode?: string;
  requestInput?: Json;
  scopeAuthority?: string[]; providerRevision?: string; providerUsage?: ProviderUsage;
}
export interface WorkflowRun {
  runId: string; context: WorkflowContext; definitionDigest: string; intentDigest: string; definition: DefinitionSnapshot;
  state: 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_EXECUTION' | 'PAUSED_UNKNOWN' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED' | 'BUDGET_EXHAUSTED';
  stateVersion: number; createdAt: number; deadline: number; activeStage: string; activation: Activation;
  activeSkillRevision: string; usedCalls: number; usedIterations: number; stageCalls: number; stageIterations: number; stageStartedAt: number;
  stageInput: Json; input: Json; output: Json | null; nodes: Record<string, NodeRecord>;
  stageOutputs: Record<string, Json>; artifactRefs: string[]; handoffs: { from: string; to: string; routeId: string; routeRevision: string; reason: string; at: number }[];
  invocations: { nodeKey: string; attempt: number; idempotencyKey: string; executionId?: string; executor: 'capability' | 'agent'; provider?: string; state: ExecutionSnapshot['state'] | 'SUBMIT_INTENT' }[];
  events: { sequence: number; at: number; type: string; stage: string }[]; failureCode?: string; stopReason?: 'USER_CANCEL' | 'BUDGET_EXHAUSTED' | 'STAGE_FAILED';
}
export interface StartRequest { workflowId: string; revision: string; input: Json; idempotencyKey: string; activationSource: Activation }
export class WorkflowError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'WorkflowError'; } }
