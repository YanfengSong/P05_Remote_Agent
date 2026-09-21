# ADR-0012 — Agent / Skill / Asset / Orchestrator Layering

Status: Accepted as V3 domain-layer decision; refined by ADR-0018
Date: 2026-09-20
V3 refinement: 2026-09-21

## Context

Foundation V2 established Workspace, Capability, Policy, Runtime, Audit/Recovery and Plugin foundations.

Architecture V3 requires:

- local Agents;
- reusable workflow Skills;
- versioned reusable implementation Assets;
- deterministic task coordination;
- dynamic implementation replacement.

Treating all of these as "plugins" would collapse domain semantics into one lifecycle mechanism.

## Decision

Keep distinct domain concepts:

1. **Agent Runtime** — generic execution-actor lifecycle; concrete implementations enter through Agent Provider Components.
2. **Capability / Binding** — stable semantic contract plus replaceable implementation.
3. **Asset** — reusable versioned implementation/input material.
4. **Skill Runtime** — bounded reusable workflows over Capability/Agent contracts.
5. **Orchestrator** — deterministic Task/dependency/parallel/handoff/reconcile coordination.
6. **Artifact** — retained output from a Run.

These concepts execute through the Trust/Durable Kernel and use the Composition Kernel for implementation/provider
availability.

## Composition refinement

ADR-0018 adds Context/Component/Fiber beneath these domain runtimes.

Important separations:

- Agent Provider registration may be Fiber-owned, but Agent Session is a durable Run.
- Skill Runtime service may be replaceable, but in-flight Skill Run pins Skill definition/version.
- Capability Binding may be Fiber-owned, but selected Binding identity is pinned in Invocation history.
- Orchestrator implementation may be replaced, but Task/Run history remains durable.
- Assets are not Fibers and do not own Policy.

Therefore dynamic composition changes implementation availability, not domain identity/history.

## Multi-Agent isolation

Concurrent writing Agents use isolated mutable roots by default.

Git Workspaces should use worktrees or equivalent Work Isolation followed by explicit verification and reconciliation.

Work Isolation is not OS sandboxing.

## Asset lifecycle

Reusable script/config Assets do not become active production Capability Bindings automatically.

Lifecycle:

```text
DRAFT -> VERIFIED -> ACTIVE -> DEPRECATED
```

Project/human approval may be required before ACTIVE.

Every revision is versioned/content-hashed.

## Authorization

Agent, Skill, Asset-backed Capability, Orchestrator and Component execution converge on:

```text
ExecutionContext
  -> Policy
  -> Capability/Binding resolution
  -> execute
  -> verify
  -> Invocation/Audit/Run state
```

No domain layer and no Component can grant itself authority.

## Reasoning boundary

ChatGPT or another planner remains the high-level reasoning authority.

The Orchestrator is deterministic coordination machinery and does not silently become an application-specific LLM
reasoning layer.

## Reuse rule

Before generating new implementation material:

1. search semantic Capability Catalog;
2. resolve existing active Bindings;
3. search verified Assets;
4. search reusable Skills;
5. only then create a new implementation candidate.

Candidate promotion follows Shadow Context verification and the normal authority model.

## Consequence

Future MATLAB/STM32 engineering behavior should increasingly become:

```text
semantic Capability
  -> verified/versioned Binding
  -> reusable Skill
```

rather than one-off scripts coupled directly to Agent prompts or filenames.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/architecture/CONTEXT-COMPONENT-RUNTIME.md
- docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md
- docs/adr/ADR-0018-trust-kernel-context-component-runtime.md
