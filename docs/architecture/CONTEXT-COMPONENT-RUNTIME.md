# P05 Context Component Runtime

Status: target Architecture V3 contract
Date: 2026-09-21
Parent: TARGET_ARCHITECTURE_V3.md
Research: ../research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md

## 1. Purpose

This document defines the dynamic composition runtime for next-generation P05.

It adopts the useful parts of the Context/Fiber/Effect/Coeffect model while preserving P05's stronger requirements for:

- durable Runs;
- immutable execution authority;
- explicit side-effect classes;
- approval;
- engineering-resource leases;
- work/security isolation;
- audit and recovery.

The central rule is:

> Dynamic composition owns implementation lifetime. It never owns or expands authority.

## 2. Two-kernel architecture

P05 V3 separates two orthogonal kernels.

### 2.1 Trust / Durable Kernel

Small, privileged and non-hot-swappable by ordinary Components.

Owns:

- device identity;
- authentication/delegation identity;
- Workspace authority model;
- immutable ExecutionContext;
- Policy decisions;
- Approval verification;
- Durable Run Kernel;
- State Store integrity;
- Invocation Ledger;
- Audit integrity;
- security execution-mode enforcement;
- host Broker trust anchors.

### 2.2 Composition Kernel

Generic runtime for dynamic services and implementation lifecycle.

Owns:

- Context tree;
- typed Service Keys;
- Component specifications;
- Fiber lifecycle;
- dependency/coeffect resolution;
- local revertible Effect ownership;
- scoped contributions;
- interceptors/events;
- declarative Component Loader;
- desired/live graph reconciliation;
- hot replacement and quiescence coordination.

Composition Kernel may itself be trusted platform code, but Components loaded through it cannot change Trust Kernel decisions merely by contributing a service.

## 3. Context

### 3.1 Definition

A Context is a live node in the composition tree.

Conceptual shape:

```ts
type ContextId = string;

interface Context {
  readonly id: ContextId;
  readonly parent?: Context;
  readonly fiber: Fiber;
  readonly metadata: Readonly<Record<PropertyKey, unknown>>;

  get<T>(key: ServiceKey<T>): T;
  tryGet<T>(key: ServiceKey<T>): T | undefined;

  extend(meta?: object): Context;
  isolate<T>(key: ServiceKey<T>, realm: IsolationRealm): Context;
  intercept<T>(key: ServiceKey<T>, metadata: unknown): Context;
}
```

A Context provides:

- service resolution;
- registration ownership;
- dependency view;
- hierarchical scope;
- composition metadata.

It is dynamic state and may change over time.

### 3.2 Context is not ExecutionContext

This is a hard architecture boundary.

Context:

- mutable live composition graph;
- chooses available implementation;
- carries Fiber/scope ownership;
- may react to configuration changes.

ExecutionContext:

- immutable execution/authorization snapshot;
- identifies Workspace/actor/device/authority/Run;
- is persisted with durable work;
- is evaluated by Policy.

A handler typically receives both:

```text
live Context
    +
immutable ExecutionContext
    |
    v
authorized implementation call
```

No code may infer authority merely because a service is visible in Context.

## 4. Service Key

### 4.1 Definition

A Service Key is a typed stable composition contract.

Conceptual shape:

```ts
type ServiceKey<T> = {
  id: string;
  contractVersion: string;
};
```

Examples:

```text
p05.capabilities
p05.agent-providers
p05.skill-registry
p05.host-process
p05.terminal
p05.work-isolation
p05.worker
p05.downstream-mcp
app.matlab
app.stm32
ui.operator-console
```

### 4.2 Single-valued and multi-valued services

Default:

- one active provider per Service Key per resolution realm.

For multiple implementations, provide one broker/registry service rather than allowing ambiguous direct providers.

Example:

```text
p05.agent-providers
    -> provider contribution: codex
    -> provider contribution: reference-agent
    -> provider contribution: future-agent
```

The broker is one Service; provider entries are Fiber-owned contributions.

## 5. Component

### 5.1 Definition

A Component is a declarative unit of dynamic composition.

Conceptual shape:

```ts
interface ComponentSpec<Config = unknown> {
  id: string;
  version: string;
  apiVersion: string;

  requires: ServiceRequirement[];
  provides: ServiceProvision[];
  permissions: PermissionDeclaration[];

  configSchema?: JsonSchema;

  activate(ctx: Context, config: Config): EffectBody;
}
```

A Component declares:

- what it requires;
- what it can provide;
- what permissions it may request;
- how it activates.

It does not control whether requested permissions are granted.

### 5.2 Plugin vs Component

P05 keeps Plugin as packaging/distribution/ownership concept.

Plugin may contain one or many Components.

```text
Plugin Package
   |
   +-- manifest/version/signature/owner
   +-- Component A
   +-- Component B
   +-- Assets
   +-- schemas
```

Runtime unit:

- Component -> Fiber.

Distribution unit:

- Plugin.

This avoids overloading the word Plugin with both packaging and live lifecycle semantics.

## 6. Fiber

### 6.1 Definition

Fiber is one live Component instance.

Conceptual record:

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

interface Fiber {
  readonly id: string;
  readonly componentId: string;
  readonly componentVersion: string;
  readonly parentFiberId?: string;
  readonly ctx: Context;
  readonly state: FiberState;
  readonly configRevision: string;

  dispose(): Promise<void>;
}
```

### 6.2 Fiber is not Run

Fiber:

- represents implementation lifetime;
- may be hot-swapped;
- owns E1 Effects;
- reacts to service dependency changes.

Run:

- represents durable work;
- persists through restart;
- may outlive a Fiber;
- owns execution attempts/artifacts/approvals.

A Run may reference the Fiber/Binding revision used for an attempt, but Run state is never stored only inside that Fiber.

## 7. Dependency / Coeffect model

### 7.1 Requirement

```ts
interface ServiceRequirement {
  key: string;
  versionRange: string;
  optional?: boolean;
  qualifier?: Readonly<Record<string, string>>;
}
```

A required dependency is satisfied only when:

- a visible provider exists;
- contract version matches;
- scope/realm matches;
- provider is ACTIVE;
- Policy does not prohibit the relationship where policy applies.

### 7.2 Provision

```ts
interface ServiceProvision {
  key: string;
  contractVersion: string;
  qualifier?: Readonly<Record<string, string>>;
}
```

Provider contribution becomes visible only after activation commits.

### 7.3 Reactive lifecycle

```text
DECLARED
   |
   +-- missing required deps --> PENDING
   |
   +-- deps ready -----------> ACTIVATING
                                  |
                                  +--> ACTIVE
                                  +--> FAILED

ACTIVE
   |
   +-- config/provider/dependency change --> RETIRING
                                              |
                                              v
                                           DRAINING
                                              |
                                              v
                                           DISPOSING
                                              |
                                              v
                                           DISPOSED
                                              |
                         +--------------------+----------------+
                         |                                     |
                     PENDING                              ACTIVATING
```

The runtime, not each Component, owns dependency reaction.

## 8. Effect model

### 8.1 E1 Revertible Component Effect

Only E1 Effects are automatically tied to Fiber cleanup.

Conceptual API:

```ts
type Disposer = () => void | Promise<void>;

interface EffectScope {
  effect(
    acquire: () =>
      | Disposer
      | Promise<Disposer>
      | Iterable<Disposer>
      | AsyncIterable<Disposer>,
    label?: string,
  ): Disposer;
}
```

Typical E1 effects:

- service registration;
- event listener;
- registry contribution;
- interceptor;
- timer;
- watcher;
- scoped prompt/tool contribution.

Disposers are:

- idempotent;
- owned by one Fiber;
- invoked automatically;
- awaited when asynchronous.

### 8.2 Cleanup order

Default:

- reverse registration order.

If multiple cleanup actions require strict internal sequencing, one effect owns the sequence explicitly.

A Fiber is not DISPOSED until its structural cleanup reaches quiescence or an explicit leak/error state is recorded.

## 9. Non-E1 effects

The Composition Kernel MUST reject attempts to model arbitrary external engineering mutations as automatic Fiber cleanup.

### E2 Managed Resource

Examples:

- worktree;
- process/terminal session;
- worker allocation;
- hardware/resource lease;
- downstream connection.

Has:

- durable resource id;
- acquire/release protocol;
- owner Run;
- recovery semantics.

### E3 Durable External Mutation

Examples:

- file write;
- git commit;
- MATLAB project mutation;
- external API mutation.

Uses:

- Capability effect classification;
- Invocation Ledger;
- verification;
- idempotency/deduplication where possible.

### E4 Irreversible / elevated mutation

Examples:

- git push;
- firmware flash;
- hardware actuation;
- system changes.

Uses:

- explicit Policy;
- Approval/Broker as required;
- verification/recovery;
- never Fiber auto-rollback.

## 10. Scope model

### 10.1 Root Context

Machine/global composition.

Contains platform services and root Component graph.

### 10.2 Workspace Context

Derived from Root.

May change:

- visible application services;
- Workspace Plugin/Component activation;
- Capability Binding contributions;
- workspace-local configuration.

### 10.3 Agent Context

Derived for an Agent.

May change:

- tool/capability visibility;
- Agent-local prompt contributions;
- Agent-local event listeners;
- scoped provider contributions/restrictions.

### 10.4 Run Context

Derived for temporary runtime composition and observability.

Carries:

- run id metadata;
- trace scope;
- run-local interceptors.

It does not replace persisted ExecutionContext.

### 10.5 Shadow Context

Candidate-validation realm.

Uses:

- alternate Service providers;
- candidate Component Fibers;
- test-only registrations;
- isolated verification.

Candidate effects are disposed if promotion fails.

## 11. Isolation and interception

Context-level isolation is **service resolution isolation**.

Conceptual behavior:

```text
same Service Key
   |
   +-- Root realm ----------> Provider A
   +-- Workspace realm -----> Provider B
   +-- Shadow realm --------> Candidate Provider C
```

Context-level interception adds scoped cross-cutting behavior to service access/registration.

Examples:

- telemetry tags;
- test wrappers;
- rate/budget instrumentation;
- model-visible presentation shaping.

Policy authorization remains in Trust Kernel and cannot be weakened by an interceptor.

## 12. Events and waterfalls

Composition Kernel SHOULD support typed events and ordered interception chains.

Use cases:

- lifecycle observation;
- capability graph changes;
- provider health changes;
- operator-console updates;
- pre/post presentation transforms;
- metrics.

Two classes must be distinguished:

### Observational event

Cannot change authoritative decision.

Example:

```text
fiber/state-changed
capability/binding-changed
run/status
```

### Controlled waterfall/interceptor

May transform a value inside a defined contract.

Example:

```text
prompt/assemble
tool/present
provider/select-hints
```

Security monotonicity rule:

> No composition interceptor may convert a Policy denial into allow.

## 13. Provider retirement and drain

Hot replacement needs stronger semantics than simple disposer execution.

### 13.1 Retirement protocol

1. mark Fiber RETIRING;
2. remove it from new resolution;
3. notify dependents/consumers;
4. stop issuing new leases;
5. wait for bounded drain/quiescence;
6. transfer/reattach E2 resources where contract allows;
7. mark non-transferable resources interrupted if necessary;
8. run E1 disposers;
9. mark DISPOSED.

### 13.2 Dependency ordering

A provider cannot complete disposal while an installed dependent still requires its committed provider view.

This rule prevents:

- unloading terminal service underneath an Agent;
- unloading MATLAB provider during teardown;
- removing scoped registry state before a Run commits its final output.

Drain timeout must be bounded.
Timeout outcome is explicit failure/interruption, not silent resource leakage.

## 14. Capability integration

The semantic Capability Catalog remains a Trust/Durable/Core service contract.

Dynamic implementation contributions become Component-owned Bindings.

```text
Capability: stm32.clean_build
          |
          v
Capability Resolver
          |
          +-- Binding A (CubeIDE Component Fiber)
          +-- Binding B (Verified Asset Component Fiber)
```

Rules:

- Binding registration is E1;
- selected Binding revision is pinned per Invocation;
- retiring a Binding blocks new resolution;
- in-flight Invocation keeps its recorded identity;
- fallback/rebind is explicit recovery;
- Context visibility never overrides Capability Policy.

## 15. Agent integration

Agent Provider registration is a Fiber-owned contribution to the Agent Provider Registry service.

Agent Session remains durable.

Example:

```text
Agent Provider Fiber
        |
        +-- register provider (E1)
        |
        v
Agent Runtime
        |
        +-- Agent Session Run #A
        +-- Agent Session Run #B
```

If provider Fiber retires:

- no new Agent Session selects it;
- active Sessions drain/stop/reattach according to Provider contract;
- Sessions do not disappear from durable state.

## 16. Skill / Orchestrator integration

Skill Registry, Skill Runtime and Orchestrator may themselves be replaceable services.

However:

- Skill definitions are versioned durable data/assets;
- in-flight Skill Run pins definition version;
- Task/Skill Run history is Trust/Durable Kernel state;
- Orchestrator replacement cannot rewrite history;
- Approval/Policy are not delegated to Orchestrator Component.

## 17. Declarative Component Loader

Target desired-state configuration:

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

### 17.1 Profile vs permission profile

These are different concepts.

**Composition Profile**

- desired Component graph.

**Permission/Tool Profile**

- authorization/exposure policy.

A composition profile can never enable a permission profile by implication.

## 18. Config reconciliation

Reconciler compares desired and live graph.

Possible actions:

- INSERT;
- KEEP;
- UPDATE_CONFIG;
- REPLACE;
- RETIRE;
- REMOVE.

Ordering is dependency-aware.

A configuration update that changes a Component's declared dependencies/provisions is treated as graph replacement, not arbitrary in-place mutation.

## 19. Hot module replacement

HMR is permitted only for eligible Component classes.

### Eligible by default

- presentation;
- pure adapters;
- stateless registry contributors;
- Agent Provider implementation with drain support;
- application adapters whose external resources are E2-managed.

### Not eligible by default

- Trust Kernel;
- Policy;
- State Store integrity code;
- Approval verifier;
- host Broker trust anchors;
- schema migration currently in progress.

Trust Kernel changes use process-level verified restart.

## 20. Self-evolution promotion

Target process:

```text
generated/edited candidate
   -> static validation
   -> build/tests
   -> Shadow Context load
   -> service-contract validation
   -> Effect declaration validation
   -> capability/policy tests
   -> optional approval
   -> activate candidate
   -> redirect new resolution
   -> drain old Fiber
   -> dispose old Fiber
   -> retain rollback metadata
```

No candidate may approve its own promotion when approval is required.

## 21. Observability

Operator Console SHOULD eventually render:

- Context tree;
- Fibers and states;
- service providers;
- pending requirements;
- active scopes/realms;
- registered E1 effects count;
- draining consumers;
- Run-to-Fiber/Binding relationships;
- leaked/failed cleanup;
- desired vs live configuration diff.

This is an observability projection, not a second source of runtime truth.

## 22. Target source structure

```text
src/
  trust/
    identity/
    policy/
    approval/
    audit/

  run/
    kernel.ts
    store.ts
    invocation-ledger.ts

  composition/
    context.ts
    service-key.ts
    component.ts
    fiber.ts
    effect.ts
    dependency.ts
    scope.ts
    events.ts
    reconciler.ts
    loader.ts

  capability/
    catalog.ts
    binding.ts
    resolver.ts

  plugin/
    package.ts
    manifest.ts

  agent/
  skill/
  orchestrator/

  execution/
  process/
  terminal/
  isolation/
  worker/
```

Exact physical paths may differ. Dependency ownership is normative.

## 23. Required invariants

| ID | Invariant |
|---|---|
| CCR-01 | Context visibility never grants authority. |
| CCR-02 | ExecutionContext is immutable for an execution. |
| CCR-03 | Fiber lifetime never defines durable Run lifetime. |
| CCR-04 | Every dynamic registration has one owning Fiber. |
| CCR-05 | E1 effects are automatically disposable and idempotent. |
| CCR-06 | E2/E3/E4 effects cannot be hidden inside E1 cleanup. |
| CCR-07 | Missing required services prevent activation. |
| CCR-08 | Dependency loss triggers controlled retirement/reactivation. |
| CCR-09 | A retiring provider accepts no new consumers. |
| CCR-10 | Provider disposal waits for bounded quiescence or records interruption. |
| CCR-11 | Scoped contributions resolve through one formal Context mechanism. |
| CCR-12 | Policy denial is monotonic through composition interceptors. |
| CCR-13 | In-flight Invocations pin implementation identity. |
| CCR-14 | Composition Profile cannot imply authorization. |
| CCR-15 | Trust Kernel is not ordinary hot-reloadable Component code. |

## 24. Acceptance criteria

The Context Component Runtime is architecturally validated when:

1. a Component can register a Service/Capability Binding and unload with zero stale registration;
2. a dependent Fiber waits when a required Service is absent;
3. dependency appearance activates it;
4. dependency removal retires it and restoration can reactivate it;
5. Workspace/Agent scopes can resolve different providers for the same Service Key;
6. Agent-scoped contributions disappear with the Agent scope;
7. a durable Run survives provider Fiber replacement;
8. active provider retirement blocks new use before drain;
9. E3/E4 mutations cannot be registered as automatic rollback effects;
10. a Shadow Context can validate a candidate without altering the live provider;
11. a declarative profile reconciles to a deterministic live Component graph;
12. Trust Kernel modules cannot be replaced through ordinary Plugin configuration.
