# P05 V3 — Run, Context, Capability, Agent, Skill and Asset Contracts

Status: target contracts for Architecture V3
Date: 2026-09-21
Parent:
- TARGET_ARCHITECTURE_V3.md
- CONTEXT-COMPONENT-RUNTIME.md

## 1. Concept distinctions

- **Context** — live dynamic service-composition scope.
- **ExecutionContext** — immutable execution/authority snapshot.
- **Component** — declarative runtime composition unit.
- **Fiber** — one live Component instance.
- **Run** — durable lifecycle envelope for long-running work.
- **Capability** — stable semantic contract describing what can be done.
- **Capability Binding** — versioned implementation of a Capability.
- **Plugin Package** — distribution/ownership package containing Components/Assets.
- **Asset** — reusable versioned implementation/input material.
- **Artifact** — output produced by a Run.
- **Agent** — execution actor that receives objectives.
- **Agent Provider** — concrete implementation registered into Agent Runtime.
- **Skill** — reusable bounded declarative workflow.
- **Task** — top-level coordinated objective.
- **Orchestrator** — deterministic coordinator of Tasks/Skills/Agents.
- **Host Session** — execution container on a host/Worker.
- **Work Isolation** — mutable-root collision isolation.
- **Security Mode** — host/Worker authority-containment mode.
- **Approval** — durable authorization decision beyond ordinary Policy.
- **Resource Lease** — durable ownership of a constrained engineering resource.

These concepts may reference each other but MUST NOT be collapsed.

## 2. Context vs ExecutionContext

### Context

Live composition object.

May carry/resolve:

- Service Keys;
- Fiber ownership;
- scope key;
- interception metadata;
- dynamic provider view.

May change when:

- configuration changes;
- provider appears/disappears;
- Fiber reloads;
- scope is disposed.

### ExecutionContext

Immutable execution snapshot.

Logical fields:

```ts
type ExecutionContext = {
  executionId: string;
  deviceId: string;
  workspaceId: string;
  actor: {
    type: "interactive" | "agent" | "skill" | "component" | "system";
    id: string;
  };
  parentRunId?: string;
  taskRunId?: string;
  skillRunId?: string;
  agentSessionId?: string;
  workIsolationId?: string;
  securityMode: "trusted-host" | "constrained-host" | "isolated-worker";
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

- Context visibility does not imply authority.
- ExecutionContext cannot be retargeted by later Workspace switch.
- child execution derives a new ExecutionContext linked to parent Run.
- secrets are not embedded.

## 3. Fiber vs Run

### Fiber

Ephemeral live implementation instance.

Owns:

- Component id/version;
- live Context;
- config revision;
- service dependency view;
- E1 Effects;
- lifecycle state.

### Run

Durable work record.

Owns:

- durable identity;
- Run kind;
- parent/child lineage;
- immutable ExecutionContext;
- generic state;
- cancellation;
- interruption/recovery;
- event sequence;
- trace correlation.

Rule:

> Fiber can disappear while Run remains.

No Task/Skill/Agent durable state may exist only inside a Fiber.

## 4. Durable Run contract

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
  | "WAITING_DEPENDENCY"
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
  ownerRuntime: string;
  createdAt: string;
  startedAt?: string;
  lastActivityAt: string;
  finishedAt?: string;
  recovery: RecoveryState;
  traceId: string;
  eventSeq: number;
};
```

Domain runtimes add their own state while using this envelope.

## 5. Component contract

```ts
type ComponentSpec = {
  id: string;
  version: string;
  apiVersion: string;

  requires: ServiceRequirement[];
  provides: ServiceProvision[];
  permissions: PermissionDeclaration[];

  configSchema?: JsonSchema;
};
```

Rules:

- permissions are requests/declarations, not grants;
- activation waits for required services;
- runtime registrations are owned by resulting Fiber;
- Component cannot directly mutate Trust Kernel authority.

## 6. Fiber contract

```ts
type FiberState =
  | "DECLARED"
  | "PENDING"
  | "ACTIVATING"
  | "ACTIVE"
  | "RETIRING"
  | "DRAINING"
  | "DISPOSING"
  | "FAILED"
  | "DISPOSED";
```

Fiber record includes:

- fiber id;
- component id/version;
- parent fiber;
- Context id;
- config revision;
- committed dependency/provider view;
- effect diagnostics;
- state;
- failure;
- drain status.

Provider retirement removes it from new resolution before disposal.

## 7. Service requirement/provision

```ts
type ServiceRequirement = {
  key: string;
  versionRange: string;
  optional?: boolean;
  qualifier?: Record<string, string>;
};

type ServiceProvision = {
  key: string;
  contractVersion: string;
  qualifier?: Record<string, string>;
};
```

Default service semantics:

- one direct provider per Service Key/realm;
- multi-provider behavior requires a broker/registry service.

## 8. Effect classification

### E0 PURE

No external mutation.

### E1 REVERTIBLE_COMPONENT

Fiber-owned local effect with disposer.

Examples:

- service contribution;
- Capability Binding registration;
- Agent Provider registration;
- event listener;
- interceptor;
- timer/watcher.

### E2 MANAGED_RESOURCE

Explicit resource lifecycle and recovery.

Examples:

- worktree;
- Host Session;
- process/PTY;
- Worker allocation;
- resource lease.

### E3 DURABLE_EXTERNAL

External mutation with verification/idempotency/deduplication/compensation semantics.

Examples:

- file write;
- git commit;
- model/project mutation;
- external API update.

### E4 IRREVERSIBLE_ELEVATED

High-risk/non-reversible action.

Examples:

- git push/release;
- firmware flash;
- hardware actuation;
- host system mutation.

Rules:

- only E1 is automatic Fiber cleanup;
- E2 belongs to Run/resource manager;
- E3/E4 use Invocation Ledger;
- E4 normally requires elevated Policy/Approval.

## 9. Capability contract

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
  executionModes: SecurityMode[];
  resourceRequirements?: ResourceRequirement[];
};
```

Rules:

- Capability id is semantic;
- contract version changes on semantic incompatibility;
- implementation replacement changes Binding, not Capability id;
- effect/verification semantics belong to contract.

## 10. Capability Binding contract

```ts
type BindingType =
  | "core"
  | "component-adapter"
  | "verified-asset"
  | "agent-backed"
  | "composed";

type CapabilityBinding = {
  id: string;
  version: string;
  capabilityId: string;
  capabilityVersionRange: string;
  type: BindingType;
  ownerFiberId?: string;
  ownerPackageId?: string;
  implementationRef: string;
  workspaceKinds?: string[];
  securityModes: SecurityMode[];
  softwareConstraints?: SoftwareConstraint[];
  state: "AVAILABLE" | "DRAINING" | "DEGRADED" | "DISABLED";
};
```

Rules:

- dynamic Binding registration is E1;
- resolver selects only authorized compatible ACTIVE Binding;
- selection records/pins Binding id/version;
- retiring Binding accepts no new Invocation;
- fallback Binding requires explicit recovery decision.

## 11. Invocation contract

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

Crash ambiguity for non-idempotent external effects becomes UNKNOWN until verified/inspected.

## 12. Plugin Package contract

Plugin Package contains:

- package id/version;
- API compatibility;
- publisher/trust metadata;
- Component definitions;
- Assets;
- schemas/docs;
- requested package permissions.

Plugin Package is not the live runtime object.

Component/Fiber provide live lifecycle semantics.

## 13. Asset contract

Asset = reusable versioned implementation/input material.

Fields:

- asset id;
- revision/version;
- content hash;
- owner package/project;
- runtime/media type;
- toolchain constraints;
- schema where executable;
- verification evidence;
- lifecycle state.

Lifecycle:

```text
DRAFT -> VERIFIED -> ACTIVE -> DEPRECATED
```

Changed content hash requires new revision/reverification.

Asset does not decide Policy.

## 14. Artifact contract

Artifact = output produced by Run.

Fields:

- artifact id;
- producing Run/Invocation;
- type;
- content hash;
- storage reference;
- size;
- media/schema metadata;
- retention;
- verification/signature metadata.

Artifact may become Asset only through explicit promotion.

## 15. Agent Provider contract

Provider registration is a Component/Fiber-owned contribution.

Provider descriptor may declare:

- interactive terminal required;
- persistent session;
- resume/reattach;
- structured output;
- tool bridge;
- supported security modes;
- toolchain/model constraints.

Provider operations conceptually:

```text
health
start
submit
status
output
stop
resume?
```

Provider-specific command/prompt/transport details do not leak into generic Agent contract.

## 16. Agent request/session

Agent request declares:

- objective;
- role;
- Workspace/device;
- read/write intent;
- required/allowed Capabilities;
- security/work isolation requirements;
- time/cost/token budget where measurable;
- output schema;
- DoD;
- parent Run/artifacts;
- optional provider preference.

Agent Session:

- has durable Run identity;
- records provider id/version;
- references Work Isolation;
- may own Host Sessions;
- records output/artifacts/recovery.

Provider Fiber loss does not delete Session record.

## 17. Handoff contract

Bounded Handoff Package:

- source Run;
- target role;
- objective;
- context summary;
- Artifact refs;
- change refs;
- unresolved items;
- constraints;
- output schema;
- DoD.

Full prior conversation is not forwarded by default.

Handoff does not increase authority.

## 18. Skill contract

Skill definition includes:

- id/version;
- description;
- typed input/output;
- Capability requirements;
- Agent requirements;
- workflow graph;
- DoD;
- budgets;
- recovery;
- approval points.

Allowed nodes:

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
- complete/fail/cancel.

Arbitrary executable code is not a workflow-node type.

## 19. Skill validation

Activation checks:

1. schemas;
2. graph reachability;
3. bounded loops;
4. Capability version compatibility;
5. no forbidden provider/path coupling;
6. retry compatibility with effect class;
7. Approval requirements;
8. parallel writer isolation/reconciliation;
9. output reachability;
10. DoD/budgets.

In-flight Skill Run pins Skill version.

## 20. Task / Orchestrator contract

Task Plan contains:

- objective;
- Workspace/device constraints;
- nodes/edges;
- Skill/Capability/Agent-role requirements;
- budgets;
- approvals;
- completion rules.

Orchestrator guarantees:

- dependency ordering;
- bounded parallelism;
- isolation allocation;
- resource leases;
- child Run lineage;
- explicit retry/fallback;
- Approval waiting;
- Handoff persistence;
- reconciliation;
- cancellation propagation;
- completion evaluation.

Orchestrator cannot make irreversible effects reversible.

## 21. Work Isolation contract

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

Parallel Git writers default to worktree.

## 22. Security Mode contract

```ts
type SecurityMode =
  | "trusted-host"
  | "constrained-host"
  | "isolated-worker";
```

Work Isolation and Security Mode are independent.

Context isolation is neither one.

## 23. Resource Lease contract

```ts
type ResourceRequirement =
  | { mode: "shared"; resource: string }
  | { mode: "exclusive"; resource: string }
  | { mode: "bounded"; resource: string; max: number };
```

Lease is durable metadata linked to owner Run.

Interrupted/expired leases recover conservatively.

## 24. Reconciliation contract

Input:

- source Work Isolation/result;
- target Workspace;
- originating Run lineage;
- change/Artifact refs;
- verification;
- expected base/target revision.

Result:

```text
INTEGRATED
CONFLICT
REJECTED
REWORK_REQUIRED
FAILED
```

No parallel writer silently enters target Workspace.

## 25. Approval contract

Approval record contains:

- approval id;
- requesting Run/actor;
- normalized action digest;
- Capability/effect/risk;
- Workspace/device/resource scope;
- requested time/expiry;
- resolution;
- resolver identity/source.

Approval secrets/credentials are not stored.

## 26. Composition scope contract

Scopes:

- Root Context;
- Workspace Context;
- Agent Context;
- Run Context;
- Shadow Context.

Rules:

- scoped contributions resolve through Context;
- scope disposal removes owned E1 contributions;
- scope does not modify durable authority;
- Shadow Context cannot become live without explicit promotion/reconciliation.

## 27. Dependency direction

```text
Protocol
  -> public services

Orchestrator
  -> Skill
  -> Agent Runtime
  -> Capability Resolver
  -> Run Kernel

Capability Resolver
  -> live Context graph
  -> Binding
      -> Core / Component / Asset / Agent-backed implementation

Component Runtime
  -> Trust Kernel contracts
  X cannot override Policy/Approval/Run history
```

## 28. Forbidden couplings

- Context -> authority grant.
- Fiber -> durable Run identity.
- Skill -> script filename.
- Skill -> concrete Agent executable.
- Component -> Policy force-allow.
- Asset -> authorization.
- Orchestrator -> application-specific MATLAB/STM32 logic.
- worktree -> sandbox claim.
- E3/E4 effect -> Fiber auto-disposer.
- Composition Profile -> Permission Profile elevation.
- ordinary HMR -> Trust Kernel replacement.
