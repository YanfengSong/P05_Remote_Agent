# P05 Target Architecture V3

Status: target architecture baseline
Date: 2026-09-20
Implemented baseline: Foundation V2
Research basis: docs/research/V3_TECHNICAL_RESEARCH.md

## 1. Definition

P05 V3 is a local-first, durable, extensible engineering Agent platform.

Its durable value is not a large MCP tool collection. Its value is a reusable execution system that can:

- receive work from ChatGPT or another authorized client;
- preserve explicit application state across reconnect/restart;
- coordinate long-running engineering operations;
- run multiple isolated Agents;
- reuse verified engineering capabilities instead of regenerating scripts;
- execute bounded Skills;
- reconcile parallel results;
- control applications and hardware through Plugins;
- enforce one authority model across local, remote and future multi-device execution.

V3 is the complete target architecture. Release slices such as V3-A are implementation plans derived from this
architecture and are not the definition of the target.

## 2. Architectural invariants

### V3-I01 — Protocol is an edge

MCP is an external protocol adapter, not the P05 application state model.

MCP protocol sessions, protocol revisions or extension lifecycles MUST NOT define P05 Task, Skill, Agent or Host
Session semantics.

### V3-I02 — Explicit execution context

Every long-lived or asynchronous operation owns an immutable Execution Context captured at creation.

Later changes to the interactive Workspace, profile or client connection MUST NOT retarget an existing run.

### V3-I03 — One durable run substrate

Task, Skill, Agent, Process, Search and future long-running runtimes share a Durable Run Kernel for identity,
persistence, parent/child lineage, cancellation, event sequencing, interruption and recovery.

Domain runtimes do not invent independent durability models.

### V3-I04 — One capability catalog

There is one semantic Capability Catalog.

Implementation replacement is modeled through versioned Capability Bindings, not a second competing
"Meta-Capability catalog".

### V3-I05 — Policy cannot be bypassed

Protocol, Plugin, Agent, Asset, Skill, Orchestrator, Worker and downstream execution all converge on Core
authorization/execution/audit.

No layer grants itself authority.

### V3-I06 — Work isolation and security isolation are separate

Git worktrees/session roots prevent writer collisions.

OS isolation constrains host authority.

Neither may be described as the other.

### V3-I07 — Side effects are explicit

P05 does not promise generic exactly-once external side effects.

Capability contracts classify effect/idempotency semantics and constrain retry/recovery.

### V3-I08 — Reconciliation is explicit

Parallel writers never silently integrate results.

Integration requires inspection, verification and a recorded reconciliation decision.

### V3-I09 — Skills are bounded

A Skill is a typed, versioned, declarative and bounded workflow.

Arbitrary code belongs in Capabilities, Verified Assets or Agent tasks, not in workflow control definitions.

### V3-I10 — Reasoning and coordination are separate

ChatGPT or another reasoning Agent may decide goals/plans.

The P05 Orchestrator is deterministic coordination machinery. It does not silently invent business logic through
hidden LLM calls.

## 3. Target system topology

```text
 ChatGPT / Other MCP Client / Local Admin
                 |
                 v
+-------------------------------------------+
|              Protocol Edge                |
| MCP 2026 / compatibility / auth / trace   |
| explicit handles / Tasks adapter / MRTR   |
+----------------------+--------------------+
                       |
                       v
+--------------------------------------------------------------+
|                    P05 Control Plane                         |
|                                                              |
|  +----------------+     +----------------+                    |
|  | Orchestrator   |---->| Skill Runtime  |----+               |
|  +-------+--------+     +----------------+    |               |
|          |                                     |               |
|          +------------------+                  v               |
|                             |        +----------------------+  |
|                             +------->| Capability Resolver  |  |
|                                      +----+-----------+-----+  |
|                                           |           |        |
|                                           |           +-------> Agent Runtime
|                                           |                        |
|                                           v                        v
|                                  Capability Binding          Agent Provider
+-------------------------------------------+------------------------+
                                            |
                                            v
+-------------------------------------------------------------------+
|                     P05 Core Execution Plane                      |
| Execution Context / Policy / Durable Run Kernel / Execution       |
| State Store / Audit / Trace / Approval / Resource Leases          |
+---------------------------+---------------------------------------+
                            |
          +-----------------+--------------------+
          |                 |                    |
          v                 v                    v
+----------------+  +------------------+  +-----------------------+
| Core Primitive |  | Application      |  | Verified Asset        |
| Files/Git/etc. |  | Plugin Adapter   |  | Executor              |
+-------+--------+  +---------+--------+  +-----------+-----------+
        |                     |                       |
        +---------------------+-----------------------+
                              |
                              v
+-------------------------------------------------------------------+
|                       Execution Substrate                         |
| Host Session / Process Driver / Terminal Driver / Isolation       |
| Worker Driver / Downstream MCP / Broker / Artifact Store          |
+---------------------------+---------------------------------------+
                            |
          +-----------------+-------------------+
          |                 |                   |
          v                 v                   v
   Trusted Host      Constrained Host     Isolated/Remote Worker
 Windows/apps/HW      future boundary      Sandbox/VM/device
```

Cross-cutting services:

- Workspace Registry;
- Device Registry;
- Plugin Registry;
- Capability Catalog / Binding Registry;
- Asset Registry;
- Skill Registry;
- Agent Provider Registry;
- State Store;
- Artifact Store;
- Audit / Trace;
- Approval / Broker;
- Resource Lease Manager.

## 4. Layer 0 — Protocol Edge

### 4.1 Responsibility

Protocol Edge translates an external client protocol into stable internal P05 requests.

Initial adapter:

- MCP.

Possible future adapters:

- local administrative CLI;
- HTTP API;
- peer P05 node protocol;
- automation/event trigger adapter.

### 4.2 MCP target

V3 targets MCP 2026-07-28 semantics while allowing compatibility adapters for older clients.

The edge owns:

- protocol-version handling;
- authentication identity extraction;
- client capability discovery;
- MCP tool/resource representation;
- explicit P05 handle mapping;
- optional MCP Tasks extension adaptation;
- Multi Round-Trip input/approval adaptation;
- trace-context import/export;
- result shaping and compatibility.

The edge MUST NOT own:

- Task/Skill/Agent lifecycle truth;
- Workspace authorization decisions;
- workflow state;
- application business logic.

### 4.3 Explicit application handles

P05 application handles are ordinary data:

```text
task_run_id
skill_run_id
agent_session_id
host_session_id
artifact_id
approval_id
```

An MCP Task handle, when used, maps to a P05 run but is not its canonical identity.

If a client does not support MCP Tasks, P05 may expose explicit status/output/cancel tools over the same internal
Run contract.

### 4.4 External tool surface

The external surface SHOULD remain smaller than the internal Capability Catalog.

The edge may expose:

- stable low-level Core tools;
- discovery/describe operations;
- Task/Skill/Agent control tools;
- selected high-level semantic Capabilities.

Generic dispatch MUST NOT become a policy bypass. Any capability-id based invocation still performs descriptor lookup,
schema validation, authorization, binding resolution and audit by that Capability ID.

## 5. Layer 1 — Core Context, Authority and Durable Run Kernel

### 5.1 Execution Context

Target logical shape:

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

The concrete TypeScript shape may evolve, but these semantics are fixed.

Context is immutable identity/scope data. It does not itself grant authority.

### 5.2 Durable Run Kernel

A Run is the common durable envelope for long-lived work.

Run kinds include:

- task;
- skill;
- agent;
- host-session;
- search;
- reconcile;
- future domain run types.

Generic lifecycle:

```text
CREATED
   |
   v
READY -> RUNNING ------------------------------+
           |   |   |                          |
           |   |   +-> WAITING_INPUT ---------+
           |   +-----> WAITING_APPROVAL ------+
           +---------> PAUSED -----------------+
           |
           +-> RECONCILING
           |
           +-> SUCCEEDED
           +-> FAILED
           +-> CANCELLED
           +-> INTERRUPTED
```

Not every Run kind uses every state.

Kernel-owned fields:

- run id;
- run kind;
- parent run id;
- immutable creation context;
- current generic state;
- timestamps;
- event sequence;
- cancellation state;
- interruption/recovery classification;
- owner/runtime type;
- trace correlation.

Domain-owned state remains in the domain runtime.

### 5.3 State Store

V3 defines a Storage interface.

Reference local backend:

- SQLite.

Logical data groups:

- runs;
- run events;
- execution attempts;
- approvals;
- leases;
- registries/version metadata;
- isolation allocations;
- reconciliation records;
- artifact metadata.

Requirements:

- atomic state + event transitions;
- schema migrations;
- crash recovery;
- bounded retention policies;
- concurrent readers;
- no secret values;
- no unbounded raw terminal/prompt/file payloads.

The reference SQLite deployment is local-host state. It is not stored on a network share.

### 5.4 Event and snapshot model

Every durable transition appends a monotonic Run event and updates the current snapshot transactionally.

Example:

```text
run.created
run.started
step.started
step.completed
approval.requested
approval.resolved
child.started
child.completed
run.reconciling
run.completed
```

The event log supports:

- recovery inspection;
- deterministic resume decisions;
- diagnostics;
- state migration tooling.

P05 does not require Temporal-style code replay. The active snapshot is authoritative; event history supplies lineage
and recovery evidence.

### 5.5 Cancellation

Cancellation is cooperative first and forceful only where the underlying Driver supports it.

Cancellation propagates explicitly through parent/child Run links according to the domain policy.

A cancelled parent does not imply that an already committed external effect was undone.

## 6. Layer 2 — Policy, Approval, Effects and Resource Leases

### 6.1 Policy inputs

Authorization considers at least:

- actor;
- tool profile;
- Workspace;
- Capability;
- Plugin/provider activation;
- requested execution mode;
- isolation allocation;
- delegated authority;
- approval state;
- resource requirements;
- external-effect class.

### 6.2 Capability effect classes

Every executable Capability declares an effect classification:

```text
PURE
READ_ONLY
IDEMPOTENT
DEDUPLICATABLE
NON_IDEMPOTENT
EXTERNAL_IRREVERSIBLE
```

This classification is part of the runtime contract.

Retry rules:

- PURE/READ_ONLY: automatic retry may be allowed.
- IDEMPOTENT: automatic retry may be allowed within policy.
- DEDUPLICATABLE: retry requires an idempotency/deduplication key.
- NON_IDEMPOTENT: automatic replay is normally prohibited.
- EXTERNAL_IRREVERSIBLE: explicit approval/recovery policy is required.

### 6.3 Invocation ledger

Every capability attempt records metadata such as:

- invocation id;
- run/step id;
- capability id/version;
- selected binding id/version;
- input digest;
- idempotency key when applicable;
- start/end state;
- result/artifact refs;
- verification result.

On recovery, P05 consults the invocation record and verification contract before deciding whether an operation can be
repeated.

### 6.4 Approval

Approval is a first-class durable object.

An Approval Request includes:

- approval id;
- requesting actor/run;
- capability/action summary;
- scope;
- effect/risk;
- target Workspace/device/resource;
- expiry;
- action digest or bounded normalized intent.

Approval may be surfaced through MCP MRTR, UI, CLI or an external broker.

**The requesting Agent cannot satisfy its own human/host approval requirement.**

### 6.5 Resource Lease Manager

Engineering operations often require exclusive resources unrelated to filesystem isolation.

Examples:

- physical ST-Link probe;
- CAN interface;
- a named MATLAB instance/license-sensitive session;
- hardware-in-loop bench;
- exclusive integration branch;
- a GUI desktop session.

Capabilities may declare resource requirements:

```text
shared(resource)
exclusive(resource)
bounded-count(resource, n)
```

The Lease Manager persists lease ownership/expiry/recovery metadata and prevents unsafe parallel scheduling.

## 7. Layer 3 — Execution Substrate

### 7.1 Host Session

Host Session is a logical runtime container for execution on one Worker/host.

It is not identical to:

- an MCP connection;
- an Agent Session;
- a single PID.

A Host Session may own a process tree, terminal, environment, output stream and security boundary.

### 7.2 Process Driver

For non-interactive commands.

Responsibilities:

- start executable/arguments;
- stdin where applicable;
- stdout/stderr events;
- exit status;
- timeout;
- graceful/force stop;
- process-tree supervision;
- resource limits where available.

It MUST NOT decide Workspace authorization.

### 7.3 Terminal Driver

For interactive TTY workloads.

Reference Windows direction:

- ConPTY via node-pty or equivalent.

Responsibilities:

- terminal creation;
- input/output;
- terminal resize;
- terminal control sequences;
- session close;
- bounded event stream.

Terminal Driver is not a sandbox.

### 7.4 Process Tree Supervisor

Windows target SHOULD use Job Object semantics if POC validation succeeds.

Purpose:

- bind descendants to a managed process tree;
- terminate a whole tree reliably;
- apply selected resource limits;
- observe tree lifecycle.

The supervisor remains behind a Driver interface so the architecture is not bound to one native library.

### 7.5 Output stream

Long-running Session output uses:

- monotonically increasing event cursor;
- bounded in-memory window;
- optional bounded spill file;
- stdout/stderr/terminal/event categories;
- truncation metadata.

Run state stores output references/metadata, not unbounded output bodies.

### 7.6 Restart behavior

Driver capability declares whether execution is:

- non-resumable;
- inspectable after restart;
- reattachable;
- externally durable.

A normal child process/PTY owned by P05 may become INTERRUPTED after P05 restart.
A Broker/Worker-backed Session may be reattached if its Driver can prove identity and ownership.

## 8. Layer 4 — Work Isolation and Security Isolation

### 8.1 Work Isolation Manager

Purpose: protect mutable engineering state from concurrent writers.

Isolation kinds:

- workspace-direct;
- git-worktree;
- session-root;
- generated/scratch root.

For Git writing Agents, git-worktree is the default.

Allocation record includes:

- isolation id;
- source Workspace;
- root;
- owning Run/Agent;
- branch/commit metadata;
- created/expiry state;
- cleanup state.

### 8.2 Reconciliation

Reconciliation is a first-class Run.

Input:

- source isolation;
- target Workspace;
- originating Agent/Skill/Task lineage;
- changed files/commits/artifacts;
- verification evidence.

Flow:

```text
collect result
  -> inspect diff/artifacts
  -> validate expected scope
  -> run required verification
  -> detect target divergence/conflict
  -> reconcile / reject / request rework
  -> integrate
  -> record result
```

No parallel writer directly writes into another writer's worktree.

### 8.3 Security Execution Modes

Security isolation is selected independently of worktree isolation.

Target modes:

1. `trusted-host`
   - normal paired Windows user authority;
   - required for many installed engineering applications;
   - policy/behavior boundary, not OS sandbox.

2. `constrained-host`
   - future restricted token/AppContainer/other host containment.

3. `isolated-worker`
   - Windows Sandbox/container/VM/dedicated remote worker.

Each Capability/Provider can declare supported/required modes.

## 9. Layer 5 — Plugin Framework

### 9.1 Plugin categories

V3 retains one common Plugin contract with typed contributions.

Plugin categories include:

- Application Plugin;
- Agent Provider Plugin;
- Worker Provider Plugin;
- future integration providers.

A plugin may contribute:

- Capability descriptors;
- Capability Bindings;
- downstream definitions;
- Asset packages;
- Agent Providers;
- Worker Providers;
- typed adapters;
- health/lifecycle hooks.

### 9.2 Trust modes

Foundation V2 built-in plugins are reviewed in-process trusted code.

V3 target trust classes:

- builtin-trusted;
- installed-trusted;
- out-of-process-isolated.

The packaging/signing mechanism for independently distributed plugins remains a separate implementation decision.

Remote callers never supply an arbitrary executable plugin path.

### 9.3 Failure isolation

Plugin failure is local where possible.

A failed Application Plugin must not crash Core.
A failed Agent Provider invalidates its sessions/providers but not unrelated providers.
An out-of-process Plugin Host failure is a recoverable provider failure.

## 10. Layer 6 — Capability Catalog, Bindings and Resolver

### 10.1 Semantic Capability

Capability describes **what can be done**.

Descriptor includes:

- stable capability id;
- contract version;
- description;
- input schema;
- output schema;
- risk;
- scope;
- effect class;
- verification contract;
- timeout/budget defaults;
- required/supported execution modes;
- resource requirements;
- tags/discovery metadata;
- compatibility constraints.

Examples:

```text
core.fs.read
core.git.commit
matlab.model.check
matlab.signal.export
stm32.clean_build
stm32.flash_verify
```

### 10.2 Capability Binding

Binding describes **how a Capability is implemented**.

Binding types:

- core primitive;
- plugin adapter;
- verified asset;
- agent-backed;
- composed capability.

Binding metadata includes:

- binding id/version;
- capability id/version range;
- owner plugin/provider;
- implementation reference;
- software/environment constraints;
- supported Workspace kinds;
- execution modes;
- health/availability;
- verification evidence;
- priority/selection hints.

### 10.3 Resolver

Capability Resolver selects an authorized compatible binding using:

- active Execution Context;
- Workspace;
- plugin activation;
- software/toolchain availability;
- execution mode;
- resource availability;
- requested constraints;
- policy.

The selected binding is recorded in the invocation ledger.

A long-running Run MUST NOT silently switch implementation revision after restart.
Resolved binding/version is pinned per invocation/step unless an explicit recovery migration occurs.

### 10.4 Meta-Capability term

"Meta-Capability" remains a useful product/domain term for a stable semantic engineering action.

Architecturally it is **not a second catalog**.
It is a Capability whose implementation is late-bound through Capability Bindings.

## 11. Layer 7 — Asset Registry and Artifact Store

### 11.1 Asset

Asset is reusable implementation/input material.

Examples:

- MATLAB .m script;
- Python/PowerShell script;
- GDB command file;
- build configuration;
- template;
- validated model-processing helper.

Lifecycle:

```text
DRAFT -> VERIFIED -> ACTIVE -> DEPRECATED
```

Optional human/project approval may be required between VERIFIED and ACTIVE.

Asset revision contains:

- stable asset id;
- revision/version;
- content hash;
- owner;
- runtime type;
- dependency/toolchain constraints;
- input/output contract;
- verification evidence;
- lifecycle state.

Changed content hash requires a new verified revision.

### 11.2 Artifact

Artifact is output produced by a Run.

Examples:

- report;
- build binary;
- test result;
- diff/patch;
- log bundle;
- generated code;
- MATLAB export;
- firmware image.

Artifact record contains:

- artifact id;
- producing run/invocation;
- type;
- content hash;
- storage reference;
- size;
- schema/media metadata;
- retention policy;
- verification/signature metadata where relevant.

Assets and Artifacts are intentionally distinct.

### 11.3 Blob storage

Large immutable content SHOULD be stored content-addressably outside operational SQLite state.

State records store references, hashes and bounded metadata.

## 12. Layer 8 — Agent Runtime

### 12.1 Definition

Agent is an execution actor that receives an objective and works using authorized capabilities/workspace access.

Agent is not itself a Capability.

Concrete Agent implementations enter through Agent Provider Plugins.

### 12.2 Provider-neutral contract

Target internal control surface:

```text
agent.providers()
agent.start(request)
agent.submit(session, task)
agent.status(session)
agent.output(session, cursor)
agent.stop(session)
agent.resume(session)        // only when provider supports it
agent.handoff(...)
```

Remote MCP tools may expose a subset.

### 12.3 Agent request

An Agent request declares:

- objective;
- role/requirements;
- Workspace;
- write/read mode;
- required Capability set;
- allowed Capability set;
- execution/security mode constraints;
- budget/time limits;
- output schema/DoD;
- parent Task/Skill;
- context/artifact references.

It does not name a concrete CLI unless the caller explicitly requested a provider.

### 12.4 Provider capabilities

Provider descriptor may declare:

- interactive terminal required;
- stateless task supported;
- persistent conversation/session supported;
- resume/reattach supported;
- structured output supported;
- tool bridge mode;
- model/provider metadata;
- execution mode support.

### 12.5 Agent Session

Agent Session is a durable application object backed by one Run.

It may own one or more Host Sessions during its lifetime.

It records:

- provider id/version;
- objective/task;
- Execution Context;
- isolation allocation;
- capability envelope;
- Host Session references;
- output/artifact references;
- recovery state.

### 12.6 Handoff package

Handoff is explicit data, not implicit conversation transfer.

Minimum Handoff Package:

- source/target role;
- objective;
- current status;
- bounded context summary;
- relevant artifact refs;
- relevant diff/commit refs;
- unresolved questions;
- constraints;
- required output/DoD;
- lineage ids.

Full prior conversation history is not forwarded by default.

## 13. Layer 9 — Skill / Workflow Runtime

### 13.1 Skill definition

Skill is a reusable executable process over Capabilities and Agent tasks.

A Skill is:

- versioned;
- immutable once ACTIVE;
- typed;
- inspectable;
- bounded;
- declarative.

Required metadata:

- skill id/version;
- description;
- input/output schemas;
- required Capability contracts;
- optional Agent requirements;
- workflow graph;
- DoD;
- stop conditions;
- retry policy;
- budgets/timeouts;
- approval points;
- recovery semantics.

### 13.2 Allowed workflow primitives

Closed primitive set:

- capability step;
- agent task step;
- sequence/dependency edge;
- condition;
- bounded loop;
- parallel fan-out;
- join;
- verify;
- approval;
- wait/event;
- retry;
- fallback;
- handoff;
- reconcile;
- complete/fail/cancel.

Every loop declares:

- exit condition;
- maximum iterations;
- maximum elapsed time or budget.

### 13.3 Skill validation

Before activation, Skill compiler/validator checks:

- graph validity;
- schema compatibility;
- Capability existence/version compatibility;
- forbidden direct provider/file bindings;
- bounded loops;
- retry/effect compatibility;
- approval requirements;
- parallel write/isolation requirements;
- output reachability;
- DoD presence.

### 13.4 Skill Run

Skill Run is a durable Run pinned to a Skill version.

At execution, each step records:

- selected Capability Binding/provider;
- child Run ids;
- inputs/outputs digests;
- attempt/retry state;
- verification state.

Skill upgrades create a new version.
An in-flight Skill Run does not silently move to a new definition.

## 14. Layer 10 — Orchestrator

### 14.1 Purpose

Orchestrator coordinates work; it does not implement engineering business logic.

It manages:

- Task Run lifecycle;
- Task Graph dependencies;
- Skill invocation;
- Agent assignment;
- parallel branches;
- resource scheduling;
- approvals;
- Handoffs;
- reconciliation;
- retries/recovery;
- result collection;
- completion.

### 14.2 Task Plan

ChatGPT or another authorized planner may submit a Task Plan.

Task Plan is explicit data:

- objective;
- Workspace/device constraints;
- nodes;
- dependencies;
- required Skills/Capabilities/Agent roles;
- budgets;
- approvals;
- completion conditions.

The Orchestrator validates the plan before execution.

### 14.3 Ad-hoc vs Skill execution

Two valid modes:

1. reusable path:
   Task -> Skill -> steps

2. ad-hoc path:
   Task -> explicit Capability/Agent graph

Successful recurring ad-hoc procedures may later be promoted to Skills, but are not automatically treated as trusted
reusable workflows.

### 14.4 Parallelism

The scheduler evaluates:

- dependency readiness;
- work isolation;
- resource leases;
- policy;
- device/provider capacity;
- budget.

Parallel writing branches receive independent Isolation allocations.

### 14.5 Completion

Task success requires its declared completion/DoD, not merely all child processes exiting zero.

Completion may require:

- verification Capabilities;
- Artifact presence;
- reconciliation success;
- approvals;
- clean integration state.

## 15. Audit, Trace and Observability

### 15.1 Separate concerns

- Durable Run state: operational truth.
- Audit: security/operation metadata.
- Trace: causal observability.
- Output: transient execution stream.
- Artifact: retained run output.

They correlate but are not interchangeable.

### 15.2 Trace model

P05 uses OpenTelemetry-compatible concepts:

- trace id;
- span id;
- parent span;
- links for joins/handoffs when parent-child is insufficient.

MCP trace context may be imported/exported at Protocol Edge.

Sensitive information is not placed in propagated baggage by default.

### 15.3 Audit

Audit remains metadata-first.

Examples:

- actor;
- capability;
- selected binding;
- Workspace/device;
- run/invocation;
- state;
- duration;
- effect class;
- approval id;
- error classification;
- recovery decision.

Raw prompt/file/terminal bodies are not automatically retained in Audit.

## 16. Error and recovery model

Errors are classified at the smallest responsible layer.

Categories include:

- policy;
- validation;
- capability-unavailable;
- binding-unavailable;
- resource-busy;
- timeout;
- process;
- terminal;
- provider;
- plugin;
- downstream;
- verification;
- conflict;
- approval;
- interrupted;
- storage;
- unknown.

Recovery action is explicit:

- retry;
- resume;
- inspect;
- fallback binding/provider;
- handoff;
- reconcile;
- request input;
- request approval;
- fail.

Recovery does not automatically repeat unsafe external effects.

## 17. Multi-device target

### 17.1 P05 Node

Each computer runs a P05 Node with its own:

- device identity;
- local Workspace registry;
- local policy;
- local state store;
- local Plugins/Providers;
- local host authority.

### 17.2 Device Registry

A controller may know multiple Nodes through Device descriptors:

- device id;
- labels;
- online state;
- capability summary;
- plugin/provider summary;
- trust/auth relationship.

### 17.3 Delegated execution

Cross-device work is explicit delegation.

The remote Node remains authoritative for its own:

- Workspace boundary;
- local policy;
- approval requirements;
- resource leases;
- host execution.

A controller cannot expand remote authority merely because it orchestrates the Task.

### 17.4 State ownership

Execution state is owned by the Node performing the work.

A higher-level Orchestrator stores remote child references/status, not a shared mutable SQLite file.

Future agent/workload identity standards may improve delegated authorization without changing these contracts.

## 18. GUI / interactive desktop target

GUI automation is optional and high-risk.

It MUST NOT be embedded into Core File/Git/Process logic.

Target model:

- GUI/Computer Interaction Provider Plugin;
- explicit interactive desktop/Worker allocation;
- bounded screenshot/input operations;
- policy/approval checks;
- Artifact capture;
- auditable session lifecycle.

For applications with stable API/CLI/MCP interfaces, those interfaces remain preferred over GUI automation.

## 19. Downstream MCP

Downstream MCP remains an implementation/provider mechanism.

Rules:

- downstream server belongs to a Plugin or explicit Core integration;
- Workspace/device binding is explicit;
- generic downstream invocation remains elevated;
- stable engineering functionality should graduate into typed semantic Capabilities;
- downstream protocol state is not exposed as P05 workflow state.

P05 may act as both MCP server and MCP client without coupling the two runtimes.

## 20. Recommended target source structure

```text
src/
  protocol/
    mcp/
      adapter.ts
      compatibility.ts
      tasks.ts

  context/
    execution-context.ts

  state/
    store.ts
    sqlite-store.ts
    migrations/

  run/
    types.ts
    kernel.ts
    events.ts
    recovery.ts

  workspace/
  device/

  capability/
    catalog.ts
    descriptor.ts
    binding.ts
    resolver.ts
    invocation.ts

  policy/
    authorization.ts
    effects.ts
    approval.ts

  resource/
    leases.ts

  execution/
    runtime.ts
    errors.ts

  session/
    host-session.ts
    output.ts

  process/
    driver.ts
    supervisor.ts
    drivers/

  terminal/
    driver.ts
    drivers/

  isolation/
    manager.ts
    git-worktree.ts
    reconcile.ts

  worker/
    provider.ts
    registry.ts
    drivers/

  plugin/
    manifest.ts
    registry.ts
    runtime.ts
    host.ts

  asset/
    registry.ts
    verification.ts
    blob-store.ts

  artifact/
    registry.ts

  agent/
    types.ts
    provider.ts
    registry.ts
    runtime.ts
    handoff.ts

  skill/
    types.ts
    validator.ts
    registry.ts
    runtime.ts

  orchestrator/
    task.ts
    graph.ts
    scheduler.ts
    runtime.ts

  audit/
  telemetry/

plugins/
  applications/
    matlab/
    stm32/
  agents/
    <provider>/
  workers/
    <provider>/

skills/
  <skill-id>/
    skill.yaml
    README.md
```

Physical migration may be incremental. Dependency direction is normative; directory names are not.

## 21. Dependency direction

Allowed high-level dependencies:

```text
Protocol Edge
   -> Orchestrator / direct public services

Orchestrator
   -> Skill Runtime
   -> Agent Runtime
   -> Capability Resolver
   -> Resource / Isolation / Approval

Skill Runtime
   -> Capability Resolver
   -> Agent Runtime
   -> Run Kernel

Agent Runtime
   -> Agent Provider
   -> Isolation
   -> Host Session
   -> Capability envelope
   -> Run Kernel

Capability Resolver
   -> Capability Binding
       -> Core Primitive
       -> Plugin Adapter
       -> Verified Asset
       -> Agent-backed implementation

All executable paths
   -> Policy
   -> Execution Runtime
   -> Run Kernel / Audit / Trace
```

Forbidden reverse dependencies:

- Core imports Skill;
- Core imports MATLAB/STM32;
- Process Driver imports Agent Provider;
- Skill binds to provider executable path;
- Asset decides policy;
- Plugin expands its own authority;
- Protocol adapter becomes lifecycle source of truth.

## 22. Architecture rules

| ID | Rule |
|---|---|
| ARC-01 | Protocol transport/session state is never P05 application state. |
| ARC-02 | Long-lived execution captures immutable Execution Context. |
| ARC-03 | All durable domain runtimes use the Run Kernel. |
| ARC-04 | One semantic Capability Catalog; implementation is in Bindings. |
| ARC-05 | Capability retry is constrained by effect/idempotency class. |
| ARC-06 | All execution passes Policy/Execution/Audit. |
| ARC-07 | Parallel writers use independent Work Isolation. |
| ARC-08 | Worktree isolation must never be represented as OS sandboxing. |
| ARC-09 | Agent Provider is late-bound and cannot grant authority. |
| ARC-10 | Skills reference semantic contracts, never implementation filenames/paths. |
| ARC-11 | Skill loops and retries are bounded. |
| ARC-12 | In-flight runs pin definition/binding revisions. |
| ARC-13 | Asset and Artifact lifecycles remain separate. |
| ARC-14 | Parallel output requires explicit reconciliation before integration. |
| ARC-15 | Approval cannot be self-issued by the requesting Agent. |
| ARC-16 | Device-local policy remains authoritative in multi-device execution. |
| ARC-17 | GUI automation is an optional provider, not Core business logic. |
| ARC-18 | Large/raw output is bounded and referenced, not stored unbounded in state/audit. |

## 23. Target public application services

These names describe stable application concepts; exact MCP exposure may differ by client/version.

### System

```text
device_list
workspace_list
workspace_current
capability_search
capability_describe
plugin_list
activity_recent
recovery_status
```

### Task

```text
task_start
task_status
task_output
task_input
task_pause
task_resume
task_cancel
```

### Skill

```text
skill_list
skill_describe
skill_run
skill_status
skill_cancel
skill_resume
```

### Agent

```text
agent_list
agent_start
agent_task
agent_status
agent_output
agent_stop
agent_handoff
```

### Capability

Typed direct capability tools may coexist with:

```text
capability_describe
capability_invoke
```

A generic invocation endpoint MUST enforce the referenced Capability's exact policy/schema/effect contract and is not a
generic arbitrary downstream proxy.

### Approval / reconciliation

```text
approval_status
reconcile_status
reconcile_apply
```

Approval resolution may be external to the Agent-facing tool surface.

## 24. V3 acceptance criteria

V3 architecture is implemented only when all of the following are true:

1. Foundation V2 security/Workspace invariants remain valid.
2. Protocol Edge can evolve independently of Core application state.
3. MCP reconnect does not lose or retarget durable P05 Runs.
4. Long-lived Runs do not depend on mutable global active Workspace identity.
5. Durable Run state survives P05 restart with explicit recovery classification.
6. State transitions are transactionally persisted.
7. Process and Terminal are separate Driver contracts.
8. Host process trees have a reliable supervisor implementation.
9. Parallel writing Agents receive isolated mutable roots.
10. Security isolation mode is explicit and separate from work isolation.
11. Multiple Agent Providers can coexist.
12. Agent Provider failure is local and recoverable.
13. Semantic Capabilities use one Catalog with replaceable Bindings.
14. Binding/Asset revisions are pinned for in-flight execution.
15. Capability effect classification controls retries.
16. Unverified Assets cannot back ACTIVE production bindings.
17. Artifacts carry producing-run lineage and content identity.
18. Skills are typed, versioned, bounded and statically validated.
19. Skills do not reference implementation paths/providers when semantic abstraction exists.
20. Orchestrator supports dependency graphs, parallel/join, approvals, handoffs and reconciliation.
21. Parallel writers cannot silently overwrite/integrate one another.
22. Resource Leases prevent unsafe parallel access to exclusive engineering resources.
23. Audit/Trace/Run/Artifact are separately modeled and correlated.
24. Core boots without Application, Agent or Worker plugins.
25. Multi-device delegation cannot broaden target-device authority.
26. GUI/isolated worker support can be added without redesigning Core Runtime.
27. The architecture works whether or not a client supports the MCP Tasks extension.
28. No subsystem requires raw unbounded prompt/terminal/file content in durable metadata state.

## 25. Implementation sequencing

Implementation should be incremental, but sequencing is subordinate to this complete target.

Recommended dependency order:

1. Protocol/state model and Execution Context.
2. Durable Run Kernel + transactional State Store.
3. Process/Terminal/Host Session Drivers.
4. Work Isolation + Resource Leases + reconciliation.
5. Capability Binding/Resolver and Asset/Artifact model.
6. Agent Runtime + reference Provider.
7. Skill validator/runtime.
8. Orchestrator.
9. application Meta-Capabilities and domain Skills.
10. multi-device / isolated workers / GUI providers.

TARGET_ARCHITECTURE_V3A.md may continue to describe an early delivery slice, but it MUST NOT narrow or redefine the
V3 target described here.

## 26. Research and decisions

Normative research basis:

- `docs/research/V3_TECHNICAL_RESEARCH.md`

Related decisions:

- ADR-0012 — Agent / Skill / Asset / Orchestrator Layering
- ADR-0013 — V3-A Execution & Agent Foundation
- later V3 ADRs for Protocol Edge, Durable Run/State, and Execution/Isolation contracts

## 27. End state

The mature system is:

```text
Human / ChatGPT reasoning
        |
        v
stateless protocol edge
        |
        v
durable task/orchestration state
        |
   +----+------------------+
   |                       |
 Skill Runtime         Agent Runtime
   |                       |
   +--------+--------------+
            v
  semantic Capability Resolver
            |
   +--------+----------+----------------+
   |                   |                |
 Core primitive   Plugin adapter   Verified Asset
   |                   |                |
   +-------------------+----------------+
                       v
           authorized execution
                       |
           Host/Terminal/Worker
                       |
        Engineering software/hardware
```

P05 V3 therefore becomes an engineering execution platform with explicit state, replaceable implementations,
recoverable coordination and controlled authority — not merely a remote desktop replacement or a larger MCP server.
