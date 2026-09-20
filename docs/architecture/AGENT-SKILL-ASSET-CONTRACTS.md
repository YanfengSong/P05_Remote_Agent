# P05 V3 — Capability, Agent, Skill, Asset and Run Contracts

Status: target contracts for Architecture V3
Date: 2026-09-20
Parent: TARGET_ARCHITECTURE_V3.md

## 1. Concept distinctions

- **Run** — durable lifecycle envelope for long-lived work.
- **Execution Context** — immutable identity/scope captured for an execution.
- **Capability** — stable semantic contract describing what can be done.
- **Capability Binding** — versioned implementation of a Capability.
- **Plugin** — trusted/isolated extension mechanism contributing implementations/providers.
- **Asset** — reusable versioned implementation/input material.
- **Artifact** — output produced by a Run.
- **Agent** — execution actor that receives objectives and uses authorized abilities.
- **Agent Provider** — concrete adapter implementing the generic Agent Runtime.
- **Skill** — reusable bounded declarative workflow.
- **Task** — top-level coordinated objective/run.
- **Orchestrator** — deterministic coordinator of Tasks, Skills, Agents, dependencies and reconciliation.
- **Host Session** — execution container on a host/worker.
- **Isolation** — allocation that separates mutable work or host authority.
- **Approval** — durable authorization decision required beyond ordinary policy.
- **Resource Lease** — durable ownership of a constrained engineering resource.

These concepts MUST NOT be collapsed merely because one implementation can perform multiple roles.

## 2. Common durable Run contract

Logical shape:

```ts
type RunKind =
  | "task"
  | "skill"
  | "agent"
  | "host-session"
  | "search"
  | "reconcile";

type RunState =
  | "CREATED"
  | "READY"
  | "RUNNING"
  | "WAITING_INPUT"
  | "WAITING_APPROVAL"
  | "PAUSED"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

type RunRecord = {
  id: string;
  kind: RunKind;
  parentRunId?: string;
  state: RunState;
  context: ExecutionContext;
  createdAt: string;
  startedAt?: string;
  lastActivityAt: string;
  finishedAt?: string;
  recovery: RecoveryState;
  traceId: string;
  eventSeq: number;
};
```

Domain runtimes MAY add domain state but MUST use this envelope for durable lifecycle/correlation.

## 3. Execution Context contract

Logical fields:

```ts
type ExecutionContext = {
  executionId: string;
  deviceId: string;
  workspaceId: string;
  actor: {
    type: "interactive" | "agent" | "plugin" | "skill" | "system";
    id: string;
  };
  parentRunId?: string;
  taskRunId?: string;
  skillRunId?: string;
  agentSessionId?: string;
  isolationId?: string;
  authority: {
    profile: string;
    delegatedAuthorityId?: string;
    approvalState?: string;
  };
  trace: {
    traceId: string;
    parentSpanId?: string;
  };
  capturedAt: string;
};
```

Rules:

- Context is immutable after capture.
- A later interactive Workspace switch cannot mutate existing Context.
- Context does not grant authority by itself; Policy evaluates it.
- Child execution derives a new Context linked to its parent.
- Sensitive credentials are never embedded in Context.

## 4. Capability contract

### 4.1 Descriptor

Logical shape:

```ts
type CapabilityEffect =
  | "PURE"
  | "READ_ONLY"
  | "IDEMPOTENT"
  | "DEDUPLICATABLE"
  | "NON_IDEMPOTENT"
  | "EXTERNAL_IRREVERSIBLE";

type CapabilityDescriptor = {
  id: string;
  contractVersion: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  risk: string;
  scope: string;
  effect: CapabilityEffect;
  verification: VerificationContract;
  executionModes: ExecutionMode[];
  resourceRequirements?: ResourceRequirement[];
  timeoutDefaults?: TimeoutPolicy;
  tags?: string[];
};
```

### 4.2 Rules

- Capability id is semantic, not an implementation filename.
- Capability version changes only when the public semantic contract changes incompatibly.
- Provider/script/tool replacement normally changes Binding version, not Capability id.
- Every executable Capability declares effect and verification semantics.
- The Catalog is the single metadata source of truth.

## 5. Capability Binding contract

Logical shape:

```ts
type BindingType =
  | "core"
  | "plugin-adapter"
  | "verified-asset"
  | "agent-backed"
  | "composed";

type CapabilityBinding = {
  id: string;
  version: string;
  capabilityId: string;
  capabilityVersionRange: string;
  type: BindingType;
  ownerId: string;
  implementationRef: string;
  workspaceKinds?: string[];
  executionModes: ExecutionMode[];
  softwareConstraints?: SoftwareConstraint[];
  verificationEvidence?: string[];
  state: "AVAILABLE" | "DEGRADED" | "DISABLED";
};
```

Rules:

- Resolver selects Binding only after Policy/compatibility checks.
- Selected Binding id/version is persisted per invocation.
- Resume/retry does not silently change Binding.
- A fallback Binding is an explicit recovery decision.
- Binding cannot widen Capability authority.

## 6. Invocation contract

Every attempt has a durable metadata record:

```ts
type InvocationRecord = {
  id: string;
  runId: string;
  stepId?: string;
  capabilityId: string;
  capabilityVersion: string;
  bindingId: string;
  bindingVersion: string;
  inputDigest: string;
  idempotencyKey?: string;
  attempt: number;
  state: "PREPARED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  resultRef?: string;
  verification?: VerificationResult;
};
```

Retry rules are derived from Capability effect class plus policy.

P05 MUST treat crash ambiguity explicitly. If a NON_IDEMPOTENT external operation may have succeeded before the
crash, recovery state is UNKNOWN until verification/human inspection resolves it.

## 7. Asset contract

Asset = reusable material, not execution output.

Logical fields:

- asset id;
- revision/version;
- content hash;
- owner plugin/project;
- runtime/media type;
- software/toolchain constraints;
- input/output schema where executable;
- verification definition/result;
- lifecycle state;
- created/verified metadata.

Lifecycle:

```text
DRAFT -> VERIFIED -> ACTIVE -> DEPRECATED
```

Rules:

- changed content hash means a new revision;
- unverified revision cannot back ACTIVE production Binding;
- Asset does not make policy decisions;
- file path is not stable Asset identity;
- active Binding pins an Asset revision/hash.

## 8. Artifact contract

Artifact = retained output produced by execution.

Logical fields:

- artifact id;
- producing run/invocation id;
- artifact type;
- content hash;
- content/storage reference;
- byte size;
- media/schema metadata;
- retention;
- verification/signature metadata;
- created timestamp.

Examples:

- build binary;
- test report;
- patch;
- firmware image;
- MATLAB export;
- generated configuration.

Artifact may later be promoted into an Asset only through an explicit verification/promotion flow.

## 9. Agent Provider contract

### 9.1 Provider descriptor

```ts
type AgentProviderDescriptor = {
  id: string;
  version: string;
  label: string;
  capabilities: {
    interactiveTerminal: boolean;
    persistentSession: boolean;
    resumableSession: boolean;
    structuredOutput: boolean;
    toolBridge: boolean;
  };
  executionModes: ExecutionMode[];
  softwareConstraints?: SoftwareConstraint[];
};
```

### 9.2 Provider operations

Conceptual interface:

```text
health()
start(agentRequest, hostAllocation)
submit(session, task)
status(session)
output(session, cursor)
stop(session, mode)
resume(session)       // optional
```

Provider-specific command lines, prompts and transport details stay inside the Provider.

## 10. Agent request and session contract

### 10.1 Agent request

Declares:

- objective;
- role/requirements;
- target Workspace/device;
- read/write intent;
- required/allowed Capability ids;
- execution/security mode constraints;
- time/token/cost budgets where measurable;
- output schema;
- Definition of Done;
- parent Task/Skill/run;
- artifact/context refs;
- optional explicit provider preference.

### 10.2 Agent Session

Agent Session fields:

- agent session id;
- Run id;
- provider id/version;
- objective;
- immutable Execution Context;
- isolation id;
- capability envelope;
- Host Session ids;
- state;
- output cursor;
- artifact/result refs;
- recovery state.

Agent Session is not an MCP session and not a Host Session.

## 11. Handoff contract

Handoff transfers responsibility/context explicitly.

Logical Handoff Package:

```ts
type HandoffPackage = {
  handoffId: string;
  sourceRunId: string;
  targetRole: string;
  objective: string;
  contextSummary: string;
  artifactRefs: string[];
  changeRefs?: string[];
  unresolvedItems: string[];
  constraints: string[];
  requiredOutputSchema?: JsonSchema;
  definitionOfDone: string[];
};
```

Rules:

- full conversation history is not forwarded by default;
- package must be bounded;
- Handoff creates lineage;
- Handoff never increases authority;
- target Provider is normally late-bound.

## 12. Skill definition contract

Logical shape:

```ts
type SkillDefinition = {
  id: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  capabilityRequirements: CapabilityRequirement[];
  agentRequirements?: AgentRequirement[];
  graph: WorkflowGraph;
  definitionOfDone: CompletionRule[];
  budgets: BudgetPolicy;
  recovery: RecoveryPolicy;
};
```

Skill version is immutable once ACTIVE.

### Allowed workflow node types

- capability;
- agent;
- condition;
- parallel;
- join;
- bounded-loop;
- verify;
- approval;
- wait;
- retry;
- fallback;
- handoff;
- reconcile;
- complete;
- fail.

Arbitrary executable script/code is not a workflow node type.

## 13. Skill validation contract

Activation requires successful static validation.

Validator checks:

1. input/output schemas valid;
2. graph reachable and terminates structurally;
3. all loops bounded;
4. Capability references exist and versions are compatible;
5. no forbidden implementation filenames/provider commands;
6. retries compatible with Capability effect class;
7. required approvals are present;
8. parallel writers require isolation/reconciliation;
9. output can be produced;
10. DoD exists;
11. budgets/timeouts are finite where required.

## 14. Skill Run contract

A Skill Run:

- is a durable Run;
- pins Skill version;
- records step states;
- records child Run ids;
- records chosen Bindings/Providers;
- records verification and approval state;
- persists enough information to resume deterministically.

In-flight Skill Runs do not silently adopt newer Skill definitions.

## 15. Task / Orchestrator contract

### 15.1 Task Plan

```ts
type TaskPlan = {
  taskId: string;
  objective: string;
  workspaceConstraints: string[];
  deviceConstraints?: string[];
  nodes: TaskNode[];
  edges: TaskEdge[];
  budgets: BudgetPolicy;
  completion: CompletionRule[];
};
```

Task nodes may reference:

- Skill;
- Capability;
- Agent role;
- approval;
- reconcile/join.

### 15.2 Orchestrator guarantees

Orchestrator guarantees:

- dependency ordering;
- bounded parallelism;
- isolation allocation;
- lease acquisition/release;
- child Run lineage;
- explicit retry/fallback;
- approval waiting;
- Handoff persistence;
- reconciliation before integration;
- cancellation propagation;
- completion evaluation.

Orchestrator does NOT guarantee that external effects are reversible.

## 16. Isolation contract

### 16.1 Work isolation

```ts
type WorkIsolation = {
  id: string;
  kind: "workspace-direct" | "git-worktree" | "session-root";
  sourceWorkspaceId: string;
  root: string;
  ownerRunId: string;
  branchRef?: string;
  baseCommit?: string;
  state: "ALLOCATED" | "ACTIVE" | "RECONCILING" | "RELEASED" | "LEAKED";
};
```

Parallel Git writers default to git-worktree.

### 16.2 Security execution mode

```ts
type ExecutionMode =
  | "trusted-host"
  | "constrained-host"
  | "isolated-worker";
```

WorkIsolation and ExecutionMode are independent fields.

## 17. Resource lease contract

```ts
type ResourceRequirement =
  | { mode: "shared"; resource: string }
  | { mode: "exclusive"; resource: string }
  | { mode: "bounded"; resource: string; max: number };
```

Lease record includes:

- lease id;
- resource;
- owning run;
- mode;
- created/expiry;
- heartbeat/renewal data if used;
- recovery state.

Expired/interrupted leases are recovered conservatively.

## 18. Reconciliation contract

Reconciliation input:

- source isolation/result;
- target Workspace;
- originating Run lineage;
- change/artifact refs;
- required verification;
- expected target/base revision.

Result:

```text
INTEGRATED
CONFLICT
REJECTED
REWORK_REQUIRED
FAILED
```

A reconciliation record identifies what was reviewed and what entered the target.

## 19. Approval contract

Approval record:

- approval id;
- requesting run/actor;
- action digest;
- description;
- Capability/effect/risk;
- Workspace/device/resource scope;
- requested at;
- expiry;
- resolution;
- resolver identity/source;
- single-use/bounded authorization token reference where needed.

Approval data is durable; credential/secret values are not.

## 20. Worker contract

Worker Provider abstracts a security/execution environment.

Examples:

- local trusted Windows host;
- future constrained Windows host;
- Windows Sandbox;
- VM/container;
- remote P05 node.

Conceptual operations:

```text
allocate(request)
exec(session, request)
status(session)
artifacts(session)
stop(session)
release(session)
```

Worker Provider cannot broaden Workspace/Capability authority.

## 21. Protocol adaptation contract

External protocols adapt to the application contracts.

For MCP:

- P05 Run ids remain canonical;
- MCP Task is optional representation;
- protocol reconnect does not change Run identity;
- MRTR/input-required may resolve P05 WAITING_INPUT/WAITING_APPROVAL;
- trace context maps to P05 trace context;
- client protocol version does not mutate domain contracts.

## 22. Dependency summary

```text
Orchestrator
  -> Skill Runtime
  -> Agent Runtime
  -> Capability Resolver
  -> Approval / Resource / Isolation
  -> Run Kernel

Skill Runtime
  -> Capability Resolver
  -> Agent Runtime
  -> Run Kernel

Agent Runtime
  -> Agent Provider
  -> Host Session / Isolation
  -> Run Kernel

Capability Resolver
  -> Binding
     -> Core / Plugin / Asset / Agent-backed implementation

Everything executable
  -> Policy
  -> Execution Runtime
  -> Audit / Trace
```

## 23. Contract-level forbidden couplings

- Skill -> script filename.
- Skill -> concrete Agent executable.
- Agent Provider -> policy override.
- Asset -> authorization.
- Protocol session -> Run identity.
- Worktree -> security claim.
- Orchestrator -> MATLAB/STM32 business logic.
- Plugin -> arbitrary self-granted host permission.
- retry -> NON_IDEMPOTENT side effect without recovery decision.
- Agent handoff -> implicit full-history leakage.
