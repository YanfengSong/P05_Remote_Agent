# ADR-0012 — Agent / Skill / Asset / Orchestrator Layering

Status: Accepted; extended by ADR-0014 through ADR-0017
Date: 2026-09-20

## Context

Foundation V2 established the generic Workspace, Capability, Policy, Runtime, Audit/Recovery and Plugin substrate.

The next expansion requires local Agents, reusable workflows and stable engineering scripts. Treating all of these as
"plugins" would collapse separate concerns and recreate tight coupling.

## Decision

Adopt five distinct extension/runtime concepts above Core:

1. Plugin Framework — optional implementation/provider extension.
2. Agent Runtime — generic execution-actor lifecycle; concrete Agents are Provider Plugins.
3. Capability Binding + Verified Asset — versioned implementations for stable semantic Capabilities.
4. Skill / Workflow Engine — bounded reusable processes over Capability IDs.
5. Orchestrator — task/parallel/handoff/reconcile coordination used by ChatGPT.

ChatGPT remains the high-level reasoning/planning authority. The Orchestrator is deterministic coordination machinery,
not an application-specific reasoning engine.

## Multi-Agent isolation

Concurrent writing Agents must use isolated work roots by default. Git workspaces should use worktrees or equivalent
session isolation, followed by explicit verification and reconciliation.

## Asset lifecycle

Script assets do not become active production Capability Bindings automatically.

Lifecycle:

DRAFT -> VERIFIED -> APPROVED/ACTIVE -> DEPRECATED

Each revision is versioned and content-hashed.

## Authorization

Plugin, Agent, Skill, Asset-backed capability and Orchestrator execution must converge on the Core Policy / Execution
Runtime / Audit path.

No layer can grant itself authority.

## Consequence

Future MATLAB/STM32 engineering work should increasingly become stable semantic Capabilities with verified
Bindings and reusable Skills rather than one-off ChatGPT-generated scripts.

The system should prefer reuse of verified capabilities before generating new implementation code.

## V3 refinement

This ADR established the separation of Plugin, Agent, reusable implementation material, Skill and Orchestrator.
The complete V3 architecture subsequently refines the model without reversing that separation:

- ADR-0014 makes MCP a Protocol Edge with explicit P05 application handles;
- ADR-0015 introduces the shared Durable Run Kernel and transactional State Store;
- ADR-0016 separates Host Session, Terminal, work isolation and security isolation;
- ADR-0017 defines one Capability Catalog with versioned Bindings and separates Asset from Artifact.

Where terminology in this ADR differs from those refinements, ADR-0014 through ADR-0017 and
TARGET_ARCHITECTURE_V3.md are normative.
