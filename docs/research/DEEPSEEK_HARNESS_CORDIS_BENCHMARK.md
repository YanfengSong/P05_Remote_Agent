# P05 Next-Generation Architecture Research — DeepSeek Harness / Cordis Benchmark

Status: technical research baseline
Date: 2026-09-21
Scope: Architecture V3 / next-generation runtime design
External references:
- https://github.com/deepseek-ai/deepseek-harness
- https://arxiv.org/abs/2608.25512

## 1. Why this benchmark matters

P05 and DeepSeek Harness arrived at a similar high-level problem from different directions.

P05 started from a controlled remote engineering Agent and progressively introduced:

- Workspace authorization;
- one Capability Catalog;
- Plugin extensions;
- long-running execution;
- Agent Providers;
- Skill/Orchestrator target contracts;
- isolation, audit and recovery.

DeepSeek Harness starts from a self-evolving Agent harness and makes dynamic composition the runtime primitive.

The important lesson is not "everything should be a plugin".
The important lesson is:

> Runtime extensibility becomes structurally safe only when ownership, dependency and cleanup are first-class runtime semantics.

The accompanying paper, *A Programming Paradigm for Spatiotemporal Composability*, formalizes two independent requirements:

- temporal composability — a component's local effects can be withdrawn when the component is removed;
- spatial composability — dependencies are declared and lifecycle reacts when those dependencies appear/disappear.

Cordis realizes those ideas using Context, Fiber, Effect, dependency injection/coeffects, derived contexts and a declarative loader.

P05 should adopt those mechanisms where they solve composition, while retaining stronger engineering safety boundaries that Harness explicitly does not attempt to prove.

## 2. What DeepSeek Harness actually does

### 2.1 Context is the shared composition surface

Cordis Context is a service container and ownership scope.

Normal service access resolves through Context.
Derived contexts do not clone the whole runtime. They change scope/metadata and can alter service resolution via:

- extend;
- isolate;
- intercept.

DeepSeek's agent-scope design uses derived contexts so one shared service graph can present different scoped registrations to different Agents.

This is directly useful to P05 for:

- per-Workspace capability views;
- per-Agent tool/capability overlays;
- per-Run interceptors;
- test/shadow environments;
- provider isolation realms.

### 2.2 Fiber is one live component instance

A Fiber represents one loaded plugin/component instance.

It owns:

- lifecycle state;
- validated configuration;
- dependency resolution snapshot;
- child fibers;
- registered effects and cleanup.

Current Harness documentation exposes lifecycle roughly as:

```text
PENDING -> LOADING -> ACTIVE
              \-> FAILED

ACTIVE -> UNLOADING -> DISPOSED
```

A component can wait in PENDING until its required services exist.
If a required service disappears, lifecycle reacts instead of leaving a stale dependency behind.

### 2.3 Effect ownership makes cleanup structural

Registrations are effects.

Examples include:

- service registrations;
- tool registrations;
- event listeners;
- child plugin mounts;
- timers/watchers/connections wrapped in ctx.effect().

The disposer is owned by the Fiber.
On unload, disposers run automatically, normally in reverse registration order.

This removes a large class of "remember to unregister everything" bugs.

### 2.4 Coeffects make dependencies reactive

Components declare what services they require.

The loader/runtime decides whether dependencies are satisfied.
Activation happens only when requirements exist.
Loss of a dependency drives deactivation/reload behavior.

This is stronger than P05 V2's current model where Plugin Runtime starts plugins explicitly and each subsystem may separately inspect availability.

### 2.5 One graph, scoped layers

Harness registries such as tools use global + scoped contribution layers.

A registration made through an Agent context can shadow or restrict the global view without cloning the underlying ToolRuntime.

Important property:

- ownership is attached to the Context/Fiber that registered the contribution;
- resolution uses one formal scope mechanism;
- cleanup occurs when that scope dies.

### 2.6 Declarative profiles/bundles

Harness composes a deployment from profile/bundle/plugin configuration.

The desired plugin tree is data.
The loader reconciles configuration changes into the live graph and supports hot replacement.

This makes runtime topology inspectable and reproducible.

### 2.7 Composition access control is not sandboxing

The Cordis paper itself separates two security mechanisms:

1. constraining which declared dependencies a Component can access;
2. sandboxing untrusted code from the host environment.

The first can be mediated through Context/dependency declarations/interception.
The second requires an execution boundary beyond ordinary language-level access control, such as a separate runtime,
sandboxed process or virtualized/containerized environment.

DeepSeek Harness's own Agent-scope design makes the same practical non-goal explicit: scoped composition proves
registration ownership/routing/lifetime, not host confinement or parent-to-child non-escalation.

This directly supports the P05 decision that:

- Context visibility/scope can narrow composition;
- Policy determines authority;
- Worker/OS isolation determines technical host confinement.

These are separate layers.

## 3. What P05 must NOT copy directly

### 3.1 No "unprivileged core" claim

DeepSeek Harness intentionally treats typed in-process plugins as trusted composition and explicitly does not prove security confinement or parent-to-child non-escalation.

P05 controls:

- arbitrary files;
- Git mutation/push;
- engineering applications;
- debuggers;
- firmware flashing;
- physical hardware;
- potentially GUI desktop authority.

Therefore P05 requires a small non-replaceable trust root.

An Agent must never hot-swap:

- identity/authentication;
- Policy decision logic;
- Approval verification;
- Audit integrity;
- execution-mode enforcement;
- durable state integrity;
- host Broker trust anchors.

### 3.2 Not every real-world effect is revertible

Cordis-style effects work extremely well for runtime-local registrations/resources where a correct disposer exists.

They do not make arbitrary external actions reversible.

Examples that are not structurally reversible:

- git push;
- remote issue/comment creation;
- firmware flash;
- sending a CAN command;
- modifying an external database;
- publishing an artifact;
- physical bench actions.

P05 must distinguish component-lifecycle cleanup from durable engineering side effects.

### 3.3 Context is not authority

A mutable/derived Context is an excellent composition mechanism.
It is a bad canonical authority record.

P05 long-running execution must retain an immutable ExecutionContext containing captured identity/Workspace/authority/isolation references.

A component may disappear or a Context may be reconfigured while a durable Run continues to exist.

### 3.4 Fiber is not durable task state

Fiber lifecycle describes a live implementation instance.

P05 Run lifecycle describes durable work:

- Task;
- Skill;
- Agent task;
- host execution;
- reconciliation.

A Run must survive process restart and component replacement.
It therefore cannot be stored only inside a Fiber.

## 4. Proposed P05 next-generation synthesis

The target becomes a two-kernel architecture.

```text
                     Protocol / UI / MCP
                            |
                            v
+------------------------------------------------------------------+
|                     TRUST / DURABLE KERNEL                       |
| Identity | Policy | Approval | ExecutionContext | Durable Run    |
| State Store | Audit | Invocation Ledger | Isolation enforcement  |
+-------------------------------+----------------------------------+
                                |
                                | authorized operations / contracts
                                v
+------------------------------------------------------------------+
|                     COMPOSITION KERNEL                           |
| Context | Service Graph | Fiber | Effect | Coeffect | Scope      |
| Intercept | Event/Waterfall | Component Loader | Reconciliation  |
+-------------------------------+----------------------------------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
 Capability Services       Agent/Skill Services   Application Services
 Bindings/Resolvers        Providers/Runtimes     MATLAB/STM32/etc.
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                                v
                     Execution / Worker substrate
```

The kernels are orthogonal:

- Trust/Durable Kernel answers: "is this allowed, and what durable work happened?"
- Composition Kernel answers: "what implementations/services are currently present, owned by whom, and what should be active?"

## 5. Core semantic split

### 5.1 Context vs ExecutionContext

**Context**

Live, hierarchical, dynamically derived composition object.

Carries or resolves:

- service bindings;
- scope identity;
- Fiber ownership;
- intercept metadata;
- component-local configuration;
- dependency views.

May change over time.

**ExecutionContext**

Immutable authorization/execution snapshot captured for one execution/Run.

Carries:

- device;
- Workspace;
- actor;
- authority/profile/delegation;
- Run lineage;
- isolation;
- trace correlation.

Must not be mutated by Context reload.

Rule:

> Context selects a currently available implementation; ExecutionContext constrains what that implementation is allowed to do.

### 5.2 Fiber vs Run

**Fiber**

Ephemeral live component instance.

Lifecycle purpose:

- dependency satisfaction;
- activate/deactivate;
- own local effects;
- hot replacement;
- cleanup.

**Run**

Durable work instance.

Lifecycle purpose:

- Task/Skill/Agent execution state;
- crash recovery;
- cancellation;
- retries;
- approvals;
- results/artifacts.

Rule:

> A Fiber may serve many Runs and may be replaced while Runs exist. A Run may wait for/rebind a compatible Fiber only through an explicit resolver/recovery decision.

## 6. Effect taxonomy for P05

P05 should use the word Effect carefully.

### Class E0 — Pure/context-free

Examples:

- schema transforms;
- parsing;
- deterministic planning helpers.

No cleanup or durable ledger needed.

### Class E1 — Revertible Component Effect

Cordis-like local effect with a structural inverse/disposer.

Examples:

- register service;
- register Capability Binding;
- register event listener;
- register Agent Provider;
- register prompt/tool contribution;
- timer/watcher;
- temporary in-memory interceptor.

Owned by Fiber.
Automatically disposed on Fiber unload.

### Class E2 — Managed Resource Effect

Resource has explicit acquire/release but may outlive a single in-memory callback and may require recovery.

Examples:

- Git worktree;
- temporary session root;
- resource lease;
- local process/PTY;
- downstream MCP connection;
- worker allocation.

Owned by a Run/Host Session with a recovery record.
A Fiber may provide the manager/driver but must not make the resource disappear merely because the provider implementation reloads.

### Class E3 — Durable External Effect

External mutation that can be idempotent/deduplicated/verified/compensated but is not safely "unwound" by component unload.

Examples:

- git commit;
- file write;
- external API mutation;
- MATLAB model mutation;
- build output promotion.

Uses Invocation Ledger and Capability effect classification.

### Class E4 — Irreversible / Human-significant Effect

Examples:

- git push/release publication;
- firmware flash;
- hardware actuation;
- system configuration;
- destructive external action.

Requires explicit Policy/Approval rules and verification.
Never auto-rollback merely because a Fiber unloads.

## 7. Reactive dependency model

A P05 Component declares typed requirements and provisions.

Conceptual manifest:

```ts
type ServiceRequirement = {
  key: ServiceKey;
  version: VersionRange;
  optional?: boolean;
  qualifier?: Record<string, string>;
};

type ComponentSpec = {
  id: string;
  version: string;
  requires: ServiceRequirement[];
  provides: ServiceProvision[];
  permissions: PermissionDeclaration;
  configSchema?: JsonSchema;
};
```

Lifecycle target:

```text
DECLARED
   |
   +-- requirements missing --> PENDING
   |
   +-- requirements ready ----> ACTIVATING
                                  |
                                  +-> ACTIVE
                                  +-> FAILED

ACTIVE -- dependency/config/provider change --> RETIRING
RETIRING --> DRAINING --> DISPOSING --> INACTIVE
                                      |
                                      +-> PENDING / ACTIVATING
```

P05 adds RETIRING/DRAINING beyond the simplest Fiber state machine because engineering Runs may still hold leases on a provider.

## 8. Dependency drain and quiescence

A provider cannot be torn down while consumers still require its live resource semantics.

P05 should model this explicitly.

Examples:

- Agent Provider Fiber is being hot-replaced while Agent Session drains;
- Terminal Driver provider is replaced while a PTY session is running;
- MATLAB connection provider reloads while a Skill step is finishing;
- a scoped capability layer is retired while a Run still pins its Binding revision.

Target rule:

1. Fiber enters RETIRING and publishes no new leases.
2. New resolution excludes it.
3. Existing consumers are notified/allowed to drain according to contract.
4. Fiber reaches quiescence.
5. E1 effects are disposed.
6. E2 resources are either transferred/reattached through a stable manager or explicitly interrupted.
7. Fiber becomes INACTIVE/DISPOSED.

This mirrors the paper's dependency-aware deactivation goal while respecting durable execution.

## 9. Service graph design

P05 SHOULD define a typed Service Key registry.

Representative service keys:

```text
p05.capabilities
p05.capability-resolver
p05.agent-providers
p05.skills
p05.host-process
p05.terminal
p05.work-isolation
p05.worker
p05.downstream-mcp
app.matlab
app.stm32
ui.operator-console
```

Default rule:

- one provider for a single-valued service key in one Context realm;
- multiple providers require an explicit broker/registry service.

This prevents accidental ambiguity.

Example:

`p05.agent-providers` is one broker service, while many Agent Provider contributions register into it as E1 effects.

## 10. Context scopes / realms

Target derived scopes:

### Root Context

Machine-wide trusted composition graph.

### Workspace Context

Adds:

- workspace metadata;
- plugin/component activation filters;
- Workspace-scoped Capability Bindings;
- application services.

### Agent Context

Adds:

- Agent/provider scope key;
- tool/capability presentation restrictions;
- Agent-local prompt/event contributions;
- scoped listeners.

### Run Context

Adds:

- Run correlation;
- observability interceptors;
- temporary contributions.

Run Context MUST NOT replace immutable ExecutionContext authority.

### Shadow Context

Used for:

- component upgrade validation;
- candidate plugin loading;
- contract tests;
- self-evolution verification.

A candidate can be loaded and tested without becoming the active provider.

## 11. Capability system integration

The existing P05 principle of one semantic Capability Catalog remains correct.

Next-generation refinement:

- Capability Catalog is a stable semantic service;
- Capability Bindings are dynamic Fiber-owned E1 contributions;
- Resolver observes the live Context graph;
- a Binding selected for an invocation is pinned in the Invocation Ledger;
- removal of a Binding prevents new selections but does not rewrite history;
- a durable Run may fallback only through explicit recovery policy.

This is similar to Harness scoped registries but retains P05's stronger version/effect/authorization semantics.

## 12. Agent / Skill / Orchestrator integration

### Agent Provider

Agent Provider becomes a component contribution.

Provider registration is E1 and automatically disappears with its Fiber.

Agent Session remains a durable Run-domain object.

### Skill

Skill definitions are durable/versioned Assets or registry records.

Skill Runtime itself is a service/component.

An executing Skill Run pins the Skill version and required contracts.
It may pause in WAITING_DEPENDENCY if an implementation temporarily disappears.

### Orchestrator

Orchestrator becomes a replaceable coordination service above the Trust Kernel, but it does not own authority.

It queries the current service/capability graph and creates durable child Runs.

Changing Orchestrator implementation cannot mutate already-authorized external side effects or rewrite Run history.

## 13. Declarative composition profiles

P05 should adopt declarative deployment composition.

Concept:

```yaml
profile: workstation-dev

bundles:
  - p05/base
  - p05/developer
  - engineering/matlab
  - engineering/stm32
  - agents/coding
  - ui/operator-console

overrides:
  p05.terminal:
    provider: windows-conpty
  p05.worker:
    provider: trusted-host
```

Profile/Bundle describes desired component graph, not authority.

Policy remains separately defined.

A Config Reconciler computes desired-vs-live graph changes:

- insert component;
- retire component;
- update config;
- replace provider;
- leave unchanged.

## 14. Self-evolution / hot replacement model

P05 self-development should evolve from process-level restart to component-level replacement where safe.

Target promotion flow:

```text
candidate source/asset
   -> build/test
   -> load in Shadow Context
   -> contract verification
   -> dependency/effect declaration verification
   -> optional human approval
   -> activate candidate Fiber
   -> atomically redirect new resolution
   -> drain old Fiber
   -> dispose old E1 effects
   -> retain rollback reference for bounded period
```

Trust Kernel modules are excluded from this path by default.

If a Trust Kernel change is needed, use the existing external restart/broker model.

## 15. Security interpretation

Context isolation is service-resolution isolation.

It is NOT:

- filesystem sandboxing;
- process sandboxing;
- Windows token confinement;
- network sandboxing.

P05 keeps the V2/V3 rule:

> Composition scopes define what services are visible; Policy and Worker/OS isolation define what effects are authorized and technically possible.

This separation is mandatory.

## 16. Benchmark mapping

| DeepSeek Harness / Cordis | P05 next-generation analogue | Difference |
|---|---|---|
| Context | P05 Context | P05 authority is separate ExecutionContext |
| Fiber | P05 Component Fiber | Fiber not durable Run |
| ctx.effect/disposer | E1 Revertible Component Effect | only local/revertible effects |
| inject/coeffect | typed Service Requirement | includes version/qualifier/policy constraints |
| derived Context | Workspace/Agent/Run/Shadow Context | not security boundary |
| scoped ToolRuntime layers | scoped Capability/Tool contributions | semantic Capability policy remains Core |
| plugin loader | Component Loader/Reconciler | cannot replace Trust Kernel by default |
| profile/bundle | P05 deployment profile/bundle | separate from permission profile |
| HMR | candidate Fiber swap + drain | pinned durable Runs respected |
| no privileged core | deliberately rejected | P05 retains Trust/Durable Kernel |

## 17. Research conclusions

### Adopt directly

- first-class Context;
- Fiber ownership;
- disposer-based local effects;
- typed declarative dependencies;
- dependency-driven lifecycle;
- derived scopes;
- declarative component tree;
- graph reconciliation/hot replacement;
- scoped contribution layers.

### Adapt

- component unloading -> add Run-aware drain/quiescence;
- Context scope -> keep separate immutable ExecutionContext;
- effects -> split into E0-E4 classes;
- provider replacement -> pin durable invocation revisions;
- "everything plugin" -> "most behavior componentized, Trust Kernel fixed".

### Reject

- treating in-process composition as a security boundary;
- treating all side effects as automatically reversible;
- tying durable task/session state to component/Fiber lifetime;
- allowing self-evolution to replace its own policy/approval trust root.

## 18. POCs before implementation freeze

1. Context prototype with service provide/require/isolate/intercept.
2. Fiber automatic cleanup and async drain.
3. Dependency removal/reappearance causing safe deactivate/reactivate.
4. Agent-scoped Capability/Tool contribution shadowing.
5. Hot-swap Agent Provider while preserving durable Agent Run metadata.
6. Shadow Context candidate validation.
7. Config tree reconciliation.
8. Effect-class enforcement proving E3/E4 cannot be registered as automatic Fiber disposers.

## 19. Reference material

DeepSeek Harness:
- docs/architecture.md
- docs/cordis-primer.zh.md
- docs/cordis-api/context.md
- docs/cordis-api/fiber.md
- docs/user/develop/framework/service.md
- docs/subsystems/tools.md
- .agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md

Paper:
- Yifan Shi, Wei Zhang, Tianyi Cui, *A Programming Paradigm for Spatiotemporal Composability*, 2026.
