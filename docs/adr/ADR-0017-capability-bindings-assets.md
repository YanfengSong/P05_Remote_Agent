# ADR-0017 — One Capability Catalog with Versioned Bindings

Status: Accepted as V3 target architecture
Date: 2026-09-20

## Context

V3 needs reusable semantic engineering actions whose implementation may change over time.

Examples:

- matlab.model.check;
- stm32.clean_build;
- stm32.flash_verify.

A naive design can create two sources of truth:

1. low-level Capability Catalog;
2. separate Meta-Capability registry.

It can also confuse reusable implementation Assets with output Artifacts.

## Decision

V3 keeps one semantic Capability Catalog.

Capability answers **what can be done** and owns:

- stable id/contract version;
- typed I/O;
- risk/scope;
- effect class;
- verification contract;
- execution/resource requirements.

Capability Binding answers **how it is implemented**.

Binding types:

- Core primitive;
- Plugin adapter;
- Verified Asset;
- Agent-backed;
- composed.

The Resolver late-binds an authorized compatible implementation and records/pins binding id/version for the invocation.

"Meta-Capability" remains a product/domain term for a stable semantic Capability with replaceable Bindings. It is not
a second registry.

## Asset vs Artifact

Asset:

- reusable versioned material;
- content-hashed;
- verified/promoted;
- may back a Binding.

Artifact:

- output produced by a Run;
- carries producing-run lineage;
- may later be explicitly promoted into an Asset.

They remain separate registries/lifecycles.

## Consequences

Positive:

- one metadata source of truth;
- workflows survive implementation replacement;
- scripts/providers are replaceable without Skill changes;
- verification and effect semantics are attached to the semantic contract;
- provenance is explicit.

Cost:

- Resolver logic and compatibility rules are required;
- active Runs must pin implementation revisions;
- promotion/versioning rules need tooling.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md
