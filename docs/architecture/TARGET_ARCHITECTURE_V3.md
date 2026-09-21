# P05 Target Architecture V3

Status: target architecture baseline
Date: 2026-09-21
Implemented baseline: Foundation V2
Primary refinement: ADR-0018 — Trust Kernel and Context Component Runtime

## 1. Definition

P05 V3 is a local-first, durable, dynamically composable engineering Agent platform.

Its value is not a large collection of MCP tools. Its value is a reusable execution and composition system that can:

- receive work from ChatGPT or other authorized clients;
- preserve explicit state across reconnect/restart;
- coordinate long-running engineering operations;
- dynamically add/remove/replace implementation components;
- run multiple isolated Agents;
- reuse semantic Capabilities across implementation changes;
- execute bounded Skills;
- reconcile parallel results;
- control applications and hardware;
- enforce one authority model across local, remote and future multi-device execution;
- evolve parts of itself without making the authority root self-replaceable.

The central V3 architecture is:

```text
 Client / ChatGPT / Operator UI
              |
              v
+-------------------------------------------+
|              Protocol Edge                |
| MCP / local API / compatibility / trace   |
+----------------------+--------------------+
                       |
                       v
+==================================================================+
|                     TRUST / DURABLE KERNEL                       |
| Identity | Workspace Authority | ExecutionContext | Policy       |
| Approval | Durable Run | State Store | Invocation Ledger         |
| Audit | Security Execution Mode | Broker Trust Anchors           |
+===============================+==================================+
                                |
                                | authorized contracts
                                v
+==================================================================+
|                     COMPOSITION KERNEL                           |
| Context | Service Graph | Component | Fiber | Effect | Coeffect  |
| Scope | Intercept | Events | Loader | Config Reconciliation      |
+===============================+==================================+
                                |
            +-------------------+-------------------+
            |                   |                   |
            v                   v                   v
   Capability Services     Agent/Skill Layer   Application Services
   Catalog/Bindings        Orchestrator        MATLAB/STM32/etc.
            |                   |                   |
            +-------------------+-------------------+
                                |
                                v
+------------------------------------------------------------------+
|                     EXECUTION SUBSTRATE                          |
| Host Session | Process | Terminal | Work Isolation | Worker      |
| Downstream MCP | Resource Lease | Artifact/Blob | Reconcile      |
+-------------------------------+----------------------------------+
                                |
          +---------------------+----------------------+
          |                     |                      |
          v                     v                      v
   Trusted Windows       Constrained Host       Isolated/Remote
      Host/Apps             future mode             Worker/Node
```

V3 combines two different kinds of composability:

1. **runtime composition** — Components/services can appear, disappear and be replaced safely;
2. **engineering execution durability** — Tasks/Runs/side effects survive failures and remain auditable.

Neither substitutes for the other.

## 2. Architectural invariants

### V3-I01 — Protocol is an edge

MCP or another client protocol is never the authoritative P05 lifecycle/state model.

### V3-I02 — Context and authority are separate

A live Context controls service composition.
An immutable ExecutionContext controls execution identity/authorization scope.

Service visibility never grants authority.

### V3-I03 — Fiber and Run are separate

Fiber is a live implementation instance.
Run is durable work.

A Fiber may be replaced while a Run exists.

### V3-I04 — One durable Run substrate

Task, Skill, Agent, Host Session, Search, Reconciliation and future long-running domains use one Durable Run Kernel.

### V3-I05 — One semantic Capability Catalog

Capability describes what can be done.
Versioned Bindings describe how.

No second competing Meta-Capability registry is required.

### V3-I06 — Local component effects are structurally owned

Dynamic registrations/listeners/services/interceptors have exactly one Fiber owner and dispose automatically.

### V3-I07 — Real-world side effects are explicit

External engineering effects are classified and recorded.
P05 does not claim arbitrary effects are reversible or exactly-once.

### V3-I08 — Policy cannot be bypassed

Plugin, Component, Agent, Skill, Orchestrator, Asset, Worker and downstream execution all converge on Trust/Durable Kernel authorization.

### V3-I09 — Work isolation and security isolation are distinct

Worktree/session roots prevent mutable-state collisions.
OS/Worker isolation constrains authority.

### V3-I10 — Reconciliation is explicit

Parallel writers do not silently integrate results.

### V3-I11 — Skills are bounded

Skill is typed/versioned/declarative/bounded.
Arbitrary executable logic belongs in Capabilities/Assets/Agents, not workflow control.

### V3-I12 — Reasoning and coordination are separate

ChatGPT or another reasoning Agent may plan.
P05 Orchestrator executes/persists deterministic coordination.

### V3-I13 — Trust root is not ordinary hot-reloadable code

Policy, Approval verification, durable state integrity and Broker trust anchors cannot be replaced by ordinary Component configuration.

## 3. Foundation V2 relationship

Foundation V2 remains the implemented security/runtime substrate.

V2 already establishes:

- registered Workspaces;
- active-workspace boundary for structured tools;
- exactly one platform-source Workspace;
- Capability Catalog;
- common Policy/Execution Runtime;
- metadata-only Audit/Recovery;
- structured Git mutation;
- Plugin Framework;
- downstream MCP;
- explicit trusted-shell limitation;
- external restart broker.

V3 evolves these ideas rather than discarding them.

Major V3 refinements:

- mutable global active Workspace is no longer sufficient for long-lived execution;
- Plugin lifecycle becomes Component/Fiber lifecycle;
- ad-hoc registries converge on Context-scoped service contributions;
- JSON-like per-subsystem persistence converges on durable state;
- Process/Terminal/Agent lifetimes separate from durable Run state;
- Capability implementation becomes Binding resolution;
- self-development can eventually use component-level replacement below the Trust Kernel.

## 4. Layer 0 — Protocol Edge

Protocol Edge translates client protocols into stable P05 application requests.

Initial protocol:

- MCP.

Possible future protocols:

- local administrative CLI/API;
- peer P05 node protocol;
- automation/event trigger adapter.

Responsibilities:

- protocol version compatibility;
- authentication identity extraction;
- request/result representation;
- explicit P05 handle mapping;
- client capability negotiation;
- trace-context import/export;
- compatibility fallbacks.

Protocol Edge MUST NOT own:

- Task/Skill/Agent lifecycle truth;
- Workspace authorization;
- workflow state;
- component dependency state;
- application business logic.

Internal identifiers such as:

```text
run_id
task_run_id
skill_run_id
agent_session_id
host_session_id
fiber_id
artifact_id
approval_id
```

remain P05 application identities regardless of transport.

## 5. Trust / Durable Kernel

Trust/Durable Kernel is deliberately small.

### 5.1 Device and identity

Owns:

- stable device identity;
- authenticated client/delegation identity;
- local node trust relationships.

### 5.2 Workspace authority

Workspace remains the logical project authorization boundary.

A Workspace defines:

- canonical root;
- type/kind;
- platform-source role where applicable;
- plugin/component activation policy;
- authorization metadata.

### 5.3 ExecutionContext

Every non-trivial or long-lived execution captures immutable ExecutionContext.

Conceptual fields:

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

ExecutionContext is data.
It cannot approve an operation by itself.

Changing the interactive Workspace does not mutate existing Contexts for Runs.

### 5.4 Policy

Authorization considers:

- actor;
- profile;
- Workspace;
- Capability;
- requested Binding;
- Plugin/Component provenance;
- execution/security mode;
- work isolation;
- resource requirements;
- effect class;
- Approval state;
- delegated authority.

No Component can force Policy allow.

### 5.5 Approval

Approval is first-class durable state.

Approval record includes:

- requesting Run/actor;
- bounded action description/digest;
- target Workspace/device/resource;
- effect/risk;
- expiry;
- resolver identity/source;
- outcome.

The requesting Agent cannot satisfy its own human/host approval requirement.

### 5.6 Durable Run Kernel

A Run is the generic durable envelope for long-lived work.

Run kinds may include:

- task;
- skill;
- agent;
- host-session;
- search;
- reconcile.

Generic states:

```text
CREATED
  -> READY
  -> RUNNING
      -> WAITING_INPUT
      -> WAITING_APPROVAL
      -> WAITING_DEPENDENCY
      -> PAUSED
      -> RECONCILING
      -> SUCCEEDED
      -> FAILED
      -> CANCELLED
      -> INTERRUPTED
```

Kernel owns:

- id;
- kind;
- parent/child lineage;
- immutable creation ExecutionContext;
- generic state;
- timestamps;
- event sequence;
- cancellation;
- interruption/recovery classification;
- trace correlation.

Domain runtimes own domain-specific state.

### 5.7 State Store

V3 defines a Storage abstraction.

Reference local backend SHOULD be SQLite.

Required semantics:

- atomic state transition + event append;
- schema migration;
- crash recovery;
- concurrent readers;
- bounded metadata;
- no secret values;
- no unbounded raw prompt/file/terminal bodies.

Large outputs/artifacts belong in Artifact/Blob storage.

### 5.8 Invocation Ledger

Every side-effecting Capability attempt records:

- invocation id;
- Run/step id;
- Capability id/version;
- Binding id/version;
- input digest;
- idempotency key when applicable;
- attempt;
- state;
- result/artifact refs;
- verification.

This protects recovery from blind replay.

### 5.9 Audit

Audit remains metadata-first and security-oriented.

Audit, Run state, trace and artifacts are separate concepts linked by ids.

## 6. Composition Kernel

Composition Kernel manages the live implementation graph.

Normative detail:
- `docs/architecture/CONTEXT-COMPONENT-RUNTIME.md`

Core concepts:

- Context;
- Service Key;
- Component;
- Fiber;
- Effect;
- Coeffect/dependency requirement;
- Scope/realm;
- Event/interceptor;
- Component Loader;
- Config Reconciler.

### 6.1 Context

Context is a live hierarchical service-resolution and ownership object.

It can be derived for:

- Workspace;
- Agent;
- Run;
- Shadow/candidate validation.

Context may:

- extend metadata;
- isolate service resolution;
- intercept service behavior within contract.

Context is never a security sandbox.

### 6.2 Component

Component is a declarative runtime unit with:

- stable id/version;
- required services;
- provided services;
- permission declaration;
- config schema;
- activation body.

### 6.3 Fiber

Fiber is one live Component instance.

Lifecycle:

```text
DECLARED
  -> PENDING
  -> ACTIVATING
  -> ACTIVE
  -> RETIRING
  -> DRAINING
  -> DISPOSING
  -> DISPOSED

ACTIVATING -> FAILED
ACTIVE/RETIRING/DRAINING -> FAILED
```

Required services control whether activation is possible.

### 6.4 E1 Revertible Component Effect

Local runtime registrations are Fiber-owned effects.

Examples:

- service contribution;
- Capability Binding contribution;
- Agent Provider registration;
- event listener;
- interceptor;
- timer/watcher;
- child Component mount.

Every E1 effect returns/owns an idempotent disposer.

Fiber unload automatically removes E1 effects.

### 6.5 Coeffect/dependency resolution

A Component declares required Service Keys.

Activation happens only when requirements are visible and compatible.

If dependencies disappear:

- provider retires;
- dependents are notified/retired according to lifecycle;
- reactivation can occur when requirements return.

The component itself does not implement ad-hoc dependency polling.

### 6.6 Retirement/drain

Retiring provider:

1. disappears from new resolution;
2. accepts no new consumers/leases;
3. notifies dependents;
4. waits for bounded quiescence;
5. transfers/reattaches managed resources where supported;
6. interrupts what cannot be transferred;
7. disposes E1 effects;
8. becomes DISPOSED.

This avoids destroying implementations under in-flight durable work.

## 7. Plugin/package model

V2 Plugin mixed package and runtime meanings.

V3 separates them.

**Plugin Package**

Distribution/ownership unit containing:

- manifest;
- version;
- API compatibility;
- signature/trust metadata where needed;
- Component definitions;
- Assets;
- schemas/docs.

**Component**

Runtime composition unit.

**Fiber**

Live Component instance.

Plugin categories may still be useful organizationally:

- Application Plugin;
- Agent Provider Plugin;
- Worker Provider Plugin;
- UI/Operator Plugin.

But all runtime activation is expressed through Components/Fibers.

Remote callers never provide arbitrary executable plugin paths.

Independent third-party packages require authenticated/reviewed packaging or an isolated Plugin Host.

## 8. Service graph

Service Key is a typed stable runtime-composition contract.

Representative keys:

```text
p05.capabilities
p05.capability-resolver
p05.agent-providers
p05.skills
p05.host-process
p05.terminal
p05.work-isolation
p05.resource-leases
p05.worker
p05.downstream-mcp
app.matlab
app.stm32
ui.operator-console
```

Default rule:

- one active direct provider per key per realm.

For many implementations, use a broker/registry service.

Example:

```text
p05.agent-providers
     -> codex contribution
     -> reference-agent contribution
     -> future provider contribution
```

Contributions are Fiber-owned E1 effects.

## 9. Capability system

P05 keeps one semantic Capability Catalog.

### 9.1 Capability Descriptor

Capability owns:

- stable id;
- contract version;
- typed input/output;
- scope/risk;
- effect class;
- verification contract;
- timeout/budget defaults;
- required execution modes/resources;
- discovery metadata.

Examples:

```text
core.fs.read
core.git.commit
matlab.model.check
stm32.clean_build
stm32.flash.verify
```

### 9.2 Capability Binding

Binding describes implementation.

Binding types:

- Core primitive;
- Component adapter;
- Verified Asset;
- Agent-backed;
- composed.

Binding contribution is dynamic and Fiber-owned.

The selected Binding id/version is pinned per Invocation.

A retired Binding cannot receive new Invocations.

### 9.3 Capability Resolver

Resolver uses:

- ExecutionContext;
- live Context;
- Workspace;
- Policy;
- software/environment compatibility;
- Component health;
- execution mode;
- resource availability;
- requested constraints.

Live Context chooses available implementations.
Trust Kernel determines whether selection/execution is authorized.

### 9.4 Meta-Capability term

Meta-Capability may remain a product/domain term for a stable semantic Capability with replaceable Bindings.

It is not a second registry.

## 10. Effect classes

P05 formally distinguishes effects.

### E0 — Pure

No external state change.

### E1 — Revertible Component Effect

Local registration/lifetime effect with structural disposer.
Fiber-owned and auto-cleaned.

### E2 — Managed Resource Effect

Explicit acquire/release resource with durable identity/recovery.

Examples:

- worktree;
- PTY/process;
- Worker allocation;
- resource lease;
- downstream connection.

Owned by Run/resource manager, not destroyed merely because provider implementation reloads.

### E3 — Durable External Mutation

Mutation that can be verified/idempotent/deduplicated/compensated but is not Fiber-reversible.

Examples:

- file write;
- git commit;
- MATLAB model mutation;
- external API update.

Uses Invocation Ledger.

### E4 — Irreversible/elevated mutation

Examples:

- git push/release publish;
- firmware flash;
- hardware actuation;
- system configuration.

Requires elevated Policy/Approval/verification.

No E3/E4 action is registered as automatic Fiber rollback.

## 11. Execution substrate

### 11.1 Host Session

Logical execution container on one host/Worker.

Not identical to:

- MCP connection;
- Agent Session;
- Fiber;
- PID.

### 11.2 Process Driver

For non-interactive commands.

Owns:

- spawn/exec;
- stdin as applicable;
- stdout/stderr events;
- exit;
- stop/kill;
- tree supervision;
- resource limits where available.

### 11.3 Terminal Driver

For interactive TTY workloads.

Windows reference direction:

- ConPTY/node-pty or equivalent.

Terminal is interaction primitive, not sandbox.

### 11.4 Process tree supervisor

Windows target SHOULD investigate Job Object-backed supervision.

### 11.5 Output

Long-running output uses:

- monotonic cursor;
- bounded window;
- optional bounded spill;
- truncation metadata;
- Artifact promotion where retention is required.

## 12. Work Isolation

Work isolation protects mutable project state.

Kinds:

- workspace-direct;
- git-worktree;
- session-root;
- scratch/generated root.

Writing Agents in Git Workspaces default to dedicated worktrees.

Worktree isolation does not limit Windows-user authority.

## 13. Security execution modes

Independent from work isolation:

1. `trusted-host`
2. `constrained-host`
3. `isolated-worker`

Capability/Agent Provider declares supported/required modes.

Policy selects what is permitted.

## 14. Resource Lease Manager

Engineering resources may need exclusivity independent of filesystem isolation.

Examples:

- ST-Link;
- CAN interface;
- hardware bench;
- MATLAB instance;
- integration branch;
- GUI desktop session.

Requirements:

```text
shared(resource)
exclusive(resource)
bounded(resource, n)
```

Leases are durable metadata and recover conservatively after interruption.

## 15. Asset and Artifact

### Asset

Reusable versioned material:

- MATLAB/Python/PowerShell/GDB script;
- config/template;
- deterministic automation helper.

Lifecycle:

```text
DRAFT -> VERIFIED -> ACTIVE -> DEPRECATED
```

Changed hash => new revision/reverification.

### Artifact

Output produced by a Run:

- report;
- binary;
- patch;
- firmware image;
- generated code;
- test result.

Artifacts carry producing Run/Invocation lineage.

Artifact becomes Asset only via explicit promotion/verification.

## 16. Agent Runtime

Agent is an execution actor, not Capability or Fiber.

Concrete Agent implementations are Provider Components.

Agent request declares:

- objective;
- role/requirements;
- Workspace;
- read/write intent;
- required/allowed Capabilities;
- execution/security constraints;
- budget/time limits;
- output schema/DoD;
- parent Run/artifacts/context refs.

Agent Session:

- is durable Run-domain state;
- references provider id/version;
- uses Work Isolation;
- may own Host Sessions;
- survives provider Fiber disappearance as explicit waiting/interrupted/recovery state.

Provider registration is E1.
Agent Session is not E1.

## 17. Handoff

Handoff is bounded explicit data:

- source/target role;
- objective;
- current status;
- bounded summary;
- Artifact/change refs;
- unresolved items;
- constraints;
- required output/DoD;
- lineage.

Full previous conversation is not forwarded by default.

Handoff never increases authority.

## 18. Skill Runtime

Skill is reusable declarative workflow.

Required:

- id/version;
- typed I/O;
- Capability requirements;
- optional Agent requirements;
- workflow graph;
- DoD;
- stop/retry rules;
- budgets/timeouts;
- approval points;
- recovery semantics.

Allowed primitives:

- Capability step;
- Agent task;
- sequence;
- condition;
- bounded loop;
- parallel;
- join;
- verify;
- approval;
- wait;
- retry;
- fallback;
- handoff;
- reconcile;
- complete/fail/cancel.

Static validation checks:

- graph;
- schema;
- Capability contracts;
- bounded loops;
- retry vs effect-class safety;
- approval requirements;
- parallel writer isolation;
- output/DoD reachability.

Executing Skill Run pins Skill version.

## 19. Orchestrator

Orchestrator coordinates durable work.

It owns:

- Task graph execution;
- dependencies;
- Skill invocation;
- Agent assignment;
- parallel branches;
- resource scheduling;
- Approval waits;
- Handoffs;
- reconciliation;
- retries/recovery;
- completion evaluation.

It MUST NOT implement MATLAB/STM32 business logic.

Orchestrator itself may be a replaceable Component service, but:

- Task/Run history lives in Trust/Durable Kernel;
- Policy/Approval do not live inside Orchestrator;
- replacing Orchestrator cannot rewrite completed Invocation history.

## 20. Declarative composition profiles

V3 adopts desired-state Component composition.

Example:

```yaml
profile: engineering-dev

bundles:
  - p05/base
  - p05/developer
  - apps/matlab
  - apps/stm32
  - agents/coding
  - ui/operator-console

components:
  p05.terminal:
    provider: windows-conpty
  p05.worker:
    provider: trusted-host
```

Composition Profile is not Tool/Permission Profile.

- Composition Profile = what Components should exist.
- Permission Profile = what remote/interactive authority is available.

One never implies the other.

## 21. Config reconciliation / HMR

Component Loader compares desired graph to live graph.

Actions:

- INSERT;
- KEEP;
- UPDATE_CONFIG;
- REPLACE;
- RETIRE;
- REMOVE.

Replacement process:

```text
candidate
  -> validate/build/test
  -> Shadow Context
  -> contract/effect/dependency tests
  -> optional approval
  -> activate candidate Fiber
  -> redirect new resolution
  -> retire old Fiber
  -> drain
  -> dispose
```

Ordinary HMR excludes Trust Kernel components.

Trust Kernel updates use verified process restart/external broker.

## 22. Self-evolution

P05 may generate or modify Components/Assets/Skills, but promotion follows authority boundaries.

Self-development is allowed.
Self-authorization is not.

Candidate code cannot:

- approve its own elevation;
- replace Policy through ordinary Component config;
- alter Audit history;
- widen Workspace authorization;
- hide E3/E4 effects as E1 cleanup.

Shadow Context is the default candidate-validation environment.

## 23. Multi-device

Each P05 Node owns:

- device identity;
- local Workspace registry;
- local Policy;
- local State Store;
- local Component graph;
- local Plugins/Providers;
- local host authority.

Cross-device work is explicit delegation.

Remote Node remains authoritative for its own Policy/Approval/resource leases.

A central controller does not share a mutable SQLite file with other nodes.

## 24. GUI / Operator Console

Operator Console is an observability/control projection over canonical runtime state.

It SHOULD display:

- device/node;
- Workspace;
- Context tree;
- Fiber state;
- pending dependencies;
- service providers;
- Component graph;
- Run state;
- Run-to-Binding/Fiber relationships;
- work/security isolation;
- approvals;
- leases;
- reconciliation;
- desired-vs-live config;
- cleanup leaks/failures.

UI is not a second source of truth.

GUI automation for engineering applications is a separate Provider/Worker concern and remains optional/high-risk.

## 25. Downstream MCP

Downstream MCP is an implementation mechanism.

Rules:

- downstream belongs to Component/Plugin ownership;
- Workspace/device binding is explicit;
- generic downstream call remains elevated;
- stable engineering behavior should become typed semantic Capabilities;
- downstream protocol state does not become P05 Run state.

## 26. Audit / trace / observability

Separate:

- Run state = operational truth;
- Audit = security/action metadata;
- Trace = causal observability;
- Output stream = transient execution data;
- Artifact = retained result;
- Fiber graph = live composition state.

They correlate but are not interchangeable.

## 27. Error and recovery

Error categories include:

- policy;
- validation;
- dependency-unavailable;
- capability-unavailable;
- binding-unavailable;
- resource-busy;
- component;
- provider;
- process;
- terminal;
- timeout;
- downstream;
- verification;
- conflict;
- approval;
- interrupted;
- storage;
- unknown.

Recovery actions:

- retry;
- resume;
- wait dependency;
- fallback Binding/provider;
- handoff;
- reconcile;
- request input;
- request Approval;
- fail.

Unsafe external effects are not blindly replayed.

## 28. Dependency direction

```text
Protocol Edge
   -> public application services

Orchestrator
   -> Skill Runtime
   -> Agent Runtime
   -> Capability Resolver
   -> Resource/Isolation/Approval
   -> Durable Run Kernel

Skill Runtime
   -> Capability Resolver
   -> Agent Runtime
   -> Durable Run Kernel

Agent Runtime
   -> Agent Provider Service
   -> Work Isolation / Host Session
   -> Durable Run Kernel

Capability Resolver
   -> live Context service graph
   -> Capability Bindings
      -> Core primitive
      -> Component adapter
      -> Verified Asset
      -> Agent-backed implementation

Composition Kernel
   -> Trust Kernel contracts
   X must not override Policy/Approval/Run history
```

Forbidden:

- Skill -> script filename;
- Skill -> Agent executable;
- Component -> Policy force-allow;
- Context -> canonical authority identity;
- Fiber -> canonical Run lifetime;
- Asset -> authorization;
- Orchestrator -> MATLAB/STM32 business logic;
- worktree -> sandbox claim;
- HMR -> Trust Kernel replacement without verified restart.

## 29. Source structure

Target logical layout:

```text
src/
  protocol/

  trust/
    identity/
    policy/
    approval/
    audit/

  workspace/
  device/

  run/
    kernel.ts
    store.ts
    events.ts
    recovery.ts
    invocation-ledger.ts

  composition/
    context.ts
    service-key.ts
    component.ts
    fiber.ts
    effect.ts
    dependency.ts
    events.ts
    scope.ts
    loader.ts
    reconciler.ts

  capability/
    catalog.ts
    descriptor.ts
    binding.ts
    resolver.ts

  plugin/
    package.ts
    manifest.ts

  resource/
    leases.ts

  session/
  process/
  terminal/
  isolation/
  worker/

  asset/
  artifact/

  agent/
  skill/
  orchestrator/

  telemetry/

plugins/
  applications/
  agents/
  workers/

skills/
```

Physical migration can be incremental.
Architectural ownership is normative.

## 30. Architecture rules

| ID | Rule |
|---|---|
| ARC-01 | Protocol state is not P05 application state. |
| ARC-02 | Context is dynamic composition; ExecutionContext is immutable authority/execution scope. |
| ARC-03 | Fiber lifetime is not durable Run lifetime. |
| ARC-04 | Every dynamic registration has exactly one Fiber owner. |
| ARC-05 | Only E1 effects use automatic Fiber disposal. |
| ARC-06 | E2/E3/E4 effects use durable execution/resource semantics. |
| ARC-07 | Missing required services prevent Component activation. |
| ARC-08 | Dependency loss causes controlled retirement/reactivation. |
| ARC-09 | Retiring providers receive no new consumers. |
| ARC-10 | Provider disposal waits for bounded drain or records interruption. |
| ARC-11 | One semantic Capability Catalog; implementation uses Bindings. |
| ARC-12 | In-flight Invocation pins Binding identity/revision. |
| ARC-13 | Policy denial cannot be reversed by composition interceptors. |
| ARC-14 | Work isolation is not security isolation. |
| ARC-15 | Parallel writers require explicit reconciliation. |
| ARC-16 | Skills are typed/versioned/bounded. |
| ARC-17 | Assets and Artifacts remain distinct. |
| ARC-18 | Composition Profile never implies Permission Profile. |
| ARC-19 | Trust Kernel is excluded from ordinary self-HMR. |
| ARC-20 | Device-local authority remains authoritative in multi-device execution. |

## 31. Acceptance criteria for V3

V3 is complete only when all of the following are true:

1. Foundation V2 authority/path/security invariants remain valid.
2. Protocol reconnect/version changes do not redefine durable P05 Runs.
3. Context/ExecutionContext separation is enforced.
4. Interactive Workspace switch cannot retarget an existing Run.
5. Durable Run state survives restart.
6. Dynamic Component registrations clean up structurally with Fiber unload.
7. Required-service loss produces controlled Component retirement.
8. Workspace/Agent/Shadow Contexts can resolve scoped implementations without cloning the whole runtime.
9. Retiring provider stops new selection before drain.
10. Durable Run can survive compatible provider Fiber replacement.
11. E3/E4 mutations cannot be represented as automatic Fiber rollback.
12. Process and Terminal are separate Driver contracts.
13. Process trees have a reliable supervisor path.
14. Parallel writing Agents use isolated mutable roots.
15. Security isolation is explicit and independent.
16. Semantic Capabilities use one Catalog with versioned Bindings.
17. In-flight Invocations pin implementation revisions.
18. Capability effect class constrains retries/recovery.
19. Unverified Assets cannot back active production Bindings.
20. Artifacts retain producing-Run lineage.
21. Multiple Agent Providers can coexist as dynamic contributions.
22. Agent Session durability is independent of Provider Fiber lifetime.
23. Skills are statically validated and bounded.
24. Orchestrator supports dependencies, parallel/join, approvals, handoff and reconcile.
25. Resource Leases prevent unsafe engineering-resource contention.
26. Parallel results cannot silently overwrite each other.
27. Trust Kernel boots without optional Application/Agent/Worker Components.
28. Ordinary Component configuration cannot replace Policy/Approval/State integrity modules.
29. Declarative composition profile deterministically reconciles to a live graph.
30. Shadow Context can validate candidate Components without modifying live resolution.
31. Operator Console can project the canonical Run + Context/Fiber graph without owning it.
32. Multi-device delegation cannot broaden target-node authority.

## 32. Research / canonical documents

- `docs/research/V3_TECHNICAL_RESEARCH.md`
- `docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md`
- `docs/architecture/CONTEXT-COMPONENT-RUNTIME.md`
- `docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md`
- `docs/architecture/PLUGIN-FRAMEWORK.md`
- `docs/architecture/PERMISSION-MODEL.md`
- `docs/architecture/TOOL-PROFILES.md`
- `docs/architecture/TARGET_ARCHITECTURE_V3A.md` (implementation slice only)
- `docs/adr/ADR-0014-protocol-edge-explicit-handles.md`
- `docs/adr/ADR-0015-durable-run-kernel-state.md`
- `docs/adr/ADR-0016-host-session-terminal-isolation.md`
- `docs/adr/ADR-0017-capability-bindings-assets.md`
- `docs/adr/ADR-0018-trust-kernel-context-component-runtime.md`

## 33. End state

The mature P05 is not "a larger remote MCP server".

It is:

```text
reasoning client
     |
stateless protocol edge
     |
trusted durable execution state
     |
dynamic context/component graph
     |
semantic capability resolution
     |
Agent / Skill / Application providers
     |
authorized execution substrate
     |
engineering software / hardware / remote nodes
```

The Trust/Durable Kernel makes authority and work history stable.
The Composition Kernel makes implementations replaceable, scoped and cleanly unloadable.

Together they provide the foundation for a self-evolving engineering Agent platform without making self-authorization
or unsafe external rollback part of the composition model.
