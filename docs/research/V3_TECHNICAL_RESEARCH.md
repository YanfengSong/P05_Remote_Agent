# P05 Architecture V3 — Technical Research

Status: architecture research baseline
Date: 2026-09-20
Scope: target V3 architecture only; this document is not an implementation plan

## 1. Research objective

P05 V3 must define the complete target architecture for a local-first remote engineering Agent platform.

The architecture must support, without collapsing concerns:

- remote MCP clients such as ChatGPT;
- long-running and asynchronous work;
- multiple concurrent local Agents;
- persistent terminal/process sessions;
- isolated mutable work roots;
- reusable engineering Capabilities;
- verified implementation Assets;
- reusable bounded Skills;
- deterministic orchestration, handoff and reconciliation;
- application plugins such as MATLAB/Simulink and STM32;
- human approvals and host brokers;
- multi-device evolution;
- optional GUI and isolated workers;
- crash recovery, audit and tracing.

This research deliberately separates target architecture from release sequencing.

## 2. Starting point

Foundation V2 already provides the right lower-level invariants:

- explicit Workspace registry and authorization boundary;
- one platform-source Workspace;
- one Capability Catalog used by policy/exposure/runtime;
- common prepare -> authorize -> execute -> verify lifecycle;
- metadata-only Audit/Recovery;
- structured Git/File operations;
- trusted-shell exception;
- Plugin Framework;
- downstream MCP registry;
- self-development without self-authorization.

V3 should preserve those invariants while replacing implicit/global execution assumptions with explicit, durable,
concurrent execution state.

## 3. External research findings

### 3.1 MCP changed materially in 2026

MCP 2026-07-28 changed the protocol architecture from a stateful transport/session model to a stateless request model.

Important findings:

1. The protocol-level initialize handshake and MCP session identifier were removed.
2. Application state is expected to use explicit server-minted handles passed as ordinary request/tool arguments.
3. Long-running work is represented by the Tasks extension rather than hidden transport state.
4. Tasks expose explicit get/update/cancel lifecycle and are authorization checked per task request.
5. Multi Round-Trip Requests provide input-required interactions without requiring a permanent bidirectional session.
6. The protocol now supports OpenTelemetry trace-context conventions.
7. The current MCP roadmap explicitly identifies agentic messaging, server-initiated events, agent identity/delegation and
   progressive discovery as active areas of evolution.

Architectural consequence for P05:

**P05 Session, Agent Session, Skill Run and Task Run are application objects and MUST NOT be modeled as MCP transport
sessions.**

The MCP edge must be an adapter. Internal state handles must remain useful even if MCP transport/version changes.

The P05 core should also avoid depending on unfinished MCP roadmap features. Where a standard extension exists,
P05 may adapt to it; where it does not, P05 retains an explicit internal contract.

Sources:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
- https://modelcontextprotocol.io/specification/draft/changelog
- https://blog.modelcontextprotocol.io/posts/mcp-roadmap/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28

### 3.2 Durable execution patterns

Temporal and Restate demonstrate mature durable-execution principles:

- control-flow decisions are persisted;
- recovery does not blindly repeat already completed steps;
- external/non-deterministic side effects are treated separately from workflow control flow;
- retries/timeouts are explicit;
- long-running runs must tolerate process restart;
- workflow/version changes must be handled intentionally;
- multi-agent routing decisions can be durable rather than recomputed after a crash.

Temporal achieves this by deterministic workflow replay plus external Activities.
Restate journals durable actions and resumes at the first unfinished action.

Both are strong references, but neither should be a mandatory V3 dependency.

Why not embed one now:

- P05 is primarily a single-device local engineering agent;
- an external durable-runtime service adds deployment and operational coupling;
- P05 workflows are intentionally bounded and narrower than a general distributed-workflow platform;
- future multi-device support can sit behind a Storage/Coordinator abstraction without redesigning Skill contracts.

Decision:

**Implement a small P05 Durable Run Kernel backed by transactional local state, borrowing durable-execution semantics
without attempting to recreate a general-purpose Temporal clone.**

Sources:

- https://docs.temporal.io/
- https://github.com/temporalio/documentation/blob/main/docs/evaluate/understanding-temporal.mdx
- https://restate.dev/
- https://docs.restate.dev/concepts/services/
- https://docs.restate.dev/ai/patterns/multi-agent

### 3.3 Local durable state

Current JSON metadata files are adequate for Foundation V2 but become fragile once V3 has concurrent Task, Skill,
Agent, Session, approval, lease and reconciliation updates.

SQLite provides:

- transactional atomic updates;
- automatic crash recovery;
- local concurrency;
- WAL mode where readers and writers can proceed concurrently;
- a single-host deployment model that matches a local P05 node.

Decision:

**V3 operational state uses a Storage abstraction with SQLite as the reference local implementation.**

The database stores state and metadata, not large logs, raw prompts, file contents or secrets.
Large execution output and artifacts live in bounded files/content-addressed storage with references in SQLite.

SQLite WAL is local-host storage and must not be placed on a network filesystem.

Sources:

- https://www.sqlite.org/atomiccommit.html
- https://www.sqlite.org/wal.html

### 3.4 Terminal sessions are not ordinary child processes

Interactive engineering Agents and CLIs often expect a terminal/TTY rather than stdin/stdout pipes.

Windows ConPTY exists specifically to host character-mode applications and relay terminal I/O.
Microsoft's node-pty provides a Node abstraction over PTYs/ConPTY and is used for terminal-emulator scenarios.

Important security fact: node-pty children run with the same permission level as the parent. PTY is an interaction
primitive, not a sandbox.

Decision:

- Process Driver: non-interactive commands using ordinary process pipes.
- Terminal Driver: interactive terminal using ConPTY/node-pty or an equivalent implementation.
- Both implement a common Host Session lifecycle, but terminal semantics remain distinct.

Sources:

- https://learn.microsoft.com/en-us/windows/console/pseudoconsoles
- https://github.com/microsoft/node-pty

### 3.5 Process-tree lifecycle requires an OS primitive

A PID alone is not a reliable process-tree lifecycle boundary.

Windows Job Objects can manage groups of processes as a unit, apply limits and terminate the associated tree.
This is a better host lifecycle primitive than relying only on recursive taskkill behavior.

Decision:

**Windows Host Process Driver should investigate a Job Object-backed supervisor.**

Job Objects improve lifecycle/resource control but are not a filesystem/security sandbox.

Source:

- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

### 3.6 Worktree isolation and security isolation are different

Git worktrees provide multiple working trees attached to one repository. They are a good collision-isolation mechanism
for concurrent writing Agents.

They do not constrain a process with ordinary Windows-user authority from touching other files.

Therefore V3 needs two independent concepts:

- Work Isolation: protects mutable project state from concurrent writers.
- Security Isolation: constrains host authority.

Reference security options on Windows:

- restricted token;
- AppContainer / Win32 app isolation;
- Windows Sandbox;
- dedicated account/VM/remote worker.

Windows Sandbox now has CLI control on Windows 11 24H2+, including start/exec/stop/share. It is a credible optional
Isolated Worker backend, but it cannot replace trusted-host execution for applications that must use software installed
and licensed on the workstation.

Sources:

- https://git-scm.com/docs/git-worktree
- https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli

### 3.7 Agent runtime and execution environment should be separate

OpenAI Agents SDK currently separates an Agent definition from its sandbox session/manifest. It also treats handoffs,
sessions, guardrails and tracing as separate runtime concerns.

This supports the P05 design direction:

- Agent = actor/provider semantics;
- Host/Isolation Session = where execution happens;
- Handoff = explicit transfer package;
- tracing = correlation, not workflow state.

P05 should remain provider-neutral and must not depend on one Agent SDK.

Sources:

- https://openai.github.io/openai-agents-python/
- https://openai.github.io/openai-agents-python/sandbox/guide/
- https://openai.github.io/openai-agents-js/guides/handoffs/
- https://openai.github.io/openai-agents-js/guides/tracing/

### 3.8 Trace correlation should follow OpenTelemetry concepts

OpenTelemetry propagates immutable trace/span context across process/service boundaries.
MCP 2026 also documents trace-context propagation conventions.

P05 should therefore separate:

- Durable Run state — authoritative operational state;
- Audit record — security/operation metadata;
- Trace/span — causal observability;
- Output/artifact — execution data.

These identifiers correlate but are not interchangeable.

Sources:

- https://opentelemetry.io/docs/concepts/context-propagation/
- https://opentelemetry.io/docs/concepts/signals/traces/

## 4. Technology decision matrix

| Concern | Options researched | V3 target |
|---|---|---|
| MCP lifecycle | protocol session / explicit handles / Tasks extension | explicit internal handles; optional Tasks adapter |
| MCP versioning | bind Core to SDK wire model / edge adapter | protocol edge adapter |
| Durable workflows | custom JSON state / XState / Temporal / Restate / bounded P05 engine | bounded P05 Durable Run Kernel + workflow interpreter |
| State persistence | JSON files / SQLite / external service | Storage API + SQLite reference backend |
| Command execution | shell only / child_process | typed Process Driver |
| Interactive CLI | child pipes / ConPTY/node-pty | Terminal Driver using PTY semantics |
| Process tree | PID/taskkill / Job Object | Job Object POC, driver abstraction |
| Write isolation | shared checkout / clone / git worktree | worktree default for Git writers |
| Hard isolation | command blacklist / restricted token / AppContainer / Sandbox/VM | optional Isolated Worker; never claim blacklist sandbox |
| Agent integration | hard-coded CLI / provider plugin | Agent Provider Plugin |
| Skill engine | prompt-only / arbitrary code / typed bounded graph | typed bounded graph/state machine |
| Reusable scripts | filename calls / content-addressed verified assets | Asset Registry + Capability Binding |
| Observability | logs only / custom IDs / OTel | common correlation IDs + OTel-compatible trace context |
| Orchestration | LLM-only loop / deterministic engine | ChatGPT reasons; P05 deterministically coordinates |
| Multi-device | shared filesystem / peer-specific logic / device abstraction | Device/Worker abstraction + explicit routing |

## 5. Core architectural decisions from the research

### R-01 — MCP is an edge protocol

No Core lifecycle object may depend on MCP transport session identity.
The MCP adapter maps explicit P05 handles to MCP result shapes/Tasks when supported.

### R-02 — One Durable Run Kernel

Task, Skill, Agent, Search and long-running execution should not each invent persistence/recovery primitives.

A common Run Kernel owns:

- stable run identity;
- type;
- state;
- parent/child relation;
- execution context;
- timestamps;
- cancellation;
- interruption/recovery classification;
- event sequence;
- correlation/trace identifiers.

Domain runtimes own domain semantics on top of the kernel.

### R-03 — Side effects have explicit semantics

P05 MUST NOT promise generic exactly-once execution for external effects.

Every executable Capability declares an effect/retry classification, for example:

- PURE / READ_ONLY;
- IDEMPOTENT;
- DEDUPLICATABLE;
- NON_IDEMPOTENT;
- EXTERNAL_IRREVERSIBLE.

A workflow retry policy is constrained by this classification.
Non-idempotent operations require verification, deduplication support or an explicit recovery/approval decision before
being repeated.

### R-04 — One Capability Catalog, separate Bindings

Do not create a second Meta-Capability catalog.

The Capability Catalog contains stable semantic contracts.
Capability Bindings map those contracts to implementations:

- Core primitive;
- Application Plugin adapter;
- Verified Asset;
- Agent Provider;
- composed Capability.

A "Meta-Capability" is therefore a semantic Capability with replaceable/versioned bindings, not another registry.

### R-05 — Asset and Artifact are different

Asset = reusable versioned implementation/input material.
Artifact = output produced by a Run.

Both may be content-addressed, but they have different lifecycle and ownership rules.

### R-06 — Agent is an actor, not a Capability

Skill/Orchestrator may create an Agent Task through Agent Runtime.
They specify role, required capabilities, workspace/isolation and output contract, not a concrete executable.

Provider selection is late-bound by Agent Registry/Policy.

### R-07 — Work isolation is mandatory for parallel writers

Git worktree is the default mutable-root allocation for writing Agents on Git Workspaces.
Integration is a separate reconciliation operation.

### R-08 — Security isolation is pluggable

Execution modes:

1. trusted-host — current engineering workstation authority;
2. constrained-host — future restricted-token/AppContainer style driver;
3. isolated-worker — Windows Sandbox/VM/container/remote worker.

Policy chooses which modes a Capability/Agent may use.

### R-09 — Skills are bounded data, not arbitrary workflow code

A Skill is a versioned declarative graph/state machine with typed I/O.
Allowed control primitives are closed and validated.

Arbitrary application logic stays in Capabilities/Assets/Agents, not in the workflow definition.

### R-10 — Orchestrator is deterministic coordination

ChatGPT or another reasoning Agent decides goals/plans.
P05 Orchestrator persists and executes the plan deterministically:

- dependencies;
- fan-out/join;
- retries;
- approval waits;
- handoff;
- reconciliation;
- cancellation;
- completion.

It does not silently call an LLM to invent new business logic.

## 6. Proposed V3 state/storage model

Reference local store:

```text
.p05/
  state/
    p05-v3.sqlite
  blobs/
    <content-hash>
  runs/
    <run-id>/bounded-output...
```

Logical tables/collections:

- runs
- run_events
- executions
- approvals
- leases
- capability_bindings
- asset_revisions
- artifact_records
- skill_versions
- agent_sessions
- isolation_allocations
- reconciliation_records

Secrets are references to an external/local credential mechanism and are not stored in these records.

## 7. Proposed identifier model

Identifiers must describe different concepts explicitly:

- device_id
- workspace_id
- trace_id / span_id
- execution_id
- task_run_id
- skill_run_id
- agent_session_id
- host_session_id
- isolation_id
- approval_id
- asset_revision_id
- artifact_id
- reconciliation_id

MCP task handles, when used, are protocol representations and are not the canonical P05 identity.

## 8. POCs required before freezing implementation technology

### POC-01 — MCP 2026 adapter compatibility

Verify the current OpenAI tunnel/client path and MCP SDK behavior with protocol revision 2026-07-28.

Questions:

- Does the current ChatGPT connection negotiate/use the new revision?
- Does the tunnel preserve required MCP headers and Tasks extension behavior?
- What compatibility path is needed for 2025-11-25 clients?

### POC-02 — node-pty / ConPTY

Verify:

- interactive PowerShell;
- Codex/other local Agent CLI;
- prompt detection;
- resize;
- UTF-8 behavior;
- bounded output;
- clean stop.

### POC-03 — Windows Job Object

Verify whether a practical Node integration can:

- place the full process tree into a Job;
- terminate reliably;
- report limits/exit;
- coexist with Agent CLIs and build tools.

### POC-04 — SQLite crash recovery

Prototype the Run Kernel with:

- transactional state + event append;
- process kill during state transition;
- restart recovery;
- concurrent reads/writes;
- migration/versioning.

### POC-05 — Git worktree reconciliation

Verify:

- two parallel writer worktrees;
- dirty source Workspace;
- branchless/detached execution;
- conflict detection;
- safe cleanup;
- artifact/diff/commit handoff.

### POC-06 — Isolated Worker

Evaluate Windows Sandbox CLI as an optional worker backend:

- startup latency;
- mapped-folder semantics;
- network control;
- toolchain availability;
- result extraction;
- suitability for untrusted scripts vs engineering tools.

## 9. Explicit non-decisions

The following should remain abstract until POC evidence exists:

- exact Job Object Node binding/library;
- exact SQLite Node package/API;
- exact Agent Provider CLI/protocol;
- whether MCP Tasks is exposed to a given client;
- third-party plugin packaging/signing mechanism;
- GUI automation provider;
- multi-device coordinator deployment topology.

The V3 contracts must survive changing any of these choices.

## 10. Research conclusion

The original V3 layering direction is valid, but it needs four architectural upgrades:

1. add a stateless Protocol Edge above the application runtime;
2. add a shared Durable Run Kernel and transactional state store;
3. split Process, Terminal, Work Isolation and Security Isolation into distinct primitives;
4. replace "Meta-Capability as another layer/catalog" with one semantic Capability Catalog plus versioned bindings.

With those changes, V3 can support local-first engineering today while retaining a clean path to Tasks, agent identity,
multi-device execution, isolated workers and richer MCP messaging later.
