# ADR-0018 — Trust Kernel and Context Component Runtime

Status: Accepted as Architecture V3 target decision
Date: 2026-09-21

## Context

P05 Foundation V2 introduced a Plugin Framework, Capability Catalog, Policy/Execution Runtime and Workspace authority.

Architecture V3 adds Agents, Skills, durable Runs, isolation and orchestration.

DeepSeek Harness/Cordis demonstrates a stronger dynamic-composition model:

- Context as shared/scoped service graph;
- Fiber as one live component instance;
- effects tied structurally to Fiber cleanup;
- declared dependencies that drive activation/deactivation;
- derived contexts for isolation/interception;
- declarative plugin-tree reconciliation and hot replacement.

Those mechanisms solve an important P05 problem: optional subsystems should not each invent registration ownership,
startup ordering, unload cleanup and dependency-loss behavior.

However, P05 controls real engineering effects and cannot adopt an "everything is replaceable and trusted" model for
its security/authority root.

## Decision

Adopt a two-kernel Architecture V3.

### Trust / Durable Kernel

Non-ordinary-hot-reloadable trust root owning:

- device/auth identity;
- Workspace authority;
- immutable ExecutionContext;
- Policy;
- Approval verification;
- Durable Run state;
- State Store integrity;
- Invocation Ledger;
- Audit integrity;
- security execution-mode enforcement;
- Broker trust anchors.

### Composition Kernel

Generic dynamic runtime owning:

- Context;
- Service Key graph;
- Component specifications;
- Fiber lifecycle;
- dependency/coeffect resolution;
- E1 revertible local effects;
- scoped service contributions;
- interceptors/events;
- declarative loader/reconciler;
- component hot replacement/drain.

## Context vs ExecutionContext

Context is dynamic composition state.

ExecutionContext is immutable execution/authority state.

A visible service does not imply authority to use it.

## Fiber vs Run

Fiber is one live implementation instance and may be hot-swapped.

Run is durable work and may survive Fiber/process replacement.

No durable Task/Skill/Agent state may exist only in a Fiber.

## Plugin vs Component

Plugin remains packaging/distribution/ownership metadata.

A Plugin may contribute one or more Components.

Component is the runtime compositional unit.
Fiber is one live Component instance.

## Effect decision

P05 recognizes multiple effect classes.

Only local structurally revertible registrations/resources are Fiber-owned automatic effects.

External engineering mutations use the Capability/Invocation/Approval model and are never treated as automatically
reversible merely because their owning Component unloads.

## Authority decision

Composition cannot widen authority.

A Component:

- may declare requested permissions;
- may contribute implementations;
- may add monotonic restrictions/interceptors;

but cannot:

- force Policy allow;
- approve itself;
- replace Trust Kernel through ordinary configuration;
- turn a worktree/context realm into a claimed OS sandbox.

## Consequences

Positive:

- registration cleanup becomes structural;
- service dependencies are declarative and reactive;
- Agent/Workspace-specific overlays no longer require parallel ad-hoc registries;
- hot replacement can occur below the durable Run layer;
- self-evolution can validate candidates in Shadow Contexts;
- the Operator Console can visualize one live component/service graph;
- P05 retains a clear security root.

Cost:

- Context/Fiber/Effect concepts must be introduced;
- existing Plugin Runtime must evolve into Component lifecycle/reconciliation;
- Provider retirement requires drain/quiescence semantics;
- effect classification becomes more explicit;
- developers must understand Context and ExecutionContext as separate objects.

## Rejected alternatives

### Make everything a replaceable Plugin

Rejected because Policy/Approval/Audit/State integrity form the P05 trust root and cannot be self-replaced under the
same authority they govern.

### Keep V2 Plugin lifecycle and add more registries

Rejected because Agent, Capability Binding, Tool, Application and future Worker contributions would duplicate
ownership, scope, cleanup and dependency resolution.

### Use Context as the security/authorization object

Rejected because Context is dynamic and changes with composition. Durable execution requires an immutable captured
authority record.

### Model all side effects as reversible Effect disposers

Rejected because many engineering actions have no safe inverse and require durable verification/approval semantics.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/architecture/CONTEXT-COMPONENT-RUNTIME.md
- docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md
- docs/architecture/PERMISSION-MODEL.md
- https://github.com/deepseek-ai/deepseek-harness
- https://arxiv.org/abs/2608.25512
