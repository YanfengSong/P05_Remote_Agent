# ADR-0015 — Durable Run Kernel and Transactional Local State

Status: Accepted as V3 target architecture
Date: 2026-09-20

## Context

V3 introduces multiple long-lived domains: Task, Skill, Agent, Host Session, Search and Reconciliation.

Allowing each domain to invent its own JSON persistence, lifecycle and restart semantics would duplicate state
machines and produce inconsistent recovery.

General durable workflow engines such as Temporal and Restate provide valuable semantics, but making one a mandatory
P05 dependency would add an external service/runtime to a local-first workstation Agent.

## Decision

V3 introduces one Durable Run Kernel.

The Run Kernel owns common:

- stable identity;
- run kind;
- parent/child lineage;
- immutable creation context;
- generic lifecycle;
- event sequence;
- cancellation;
- interruption/recovery classification;
- trace correlation.

Domain runtimes own their domain-specific state on top.

V3 defines a Storage abstraction with SQLite as the reference local backend.

Each durable state transition atomically:

1. appends the Run event;
2. updates the current Run/domain snapshot.

P05 does not implement Temporal-style deterministic code replay. Snapshot state is authoritative; event history
provides lineage, diagnostics and recovery evidence.

## Side-effect rule

P05 does not claim generic exactly-once external execution.

Capabilities classify effects as PURE, READ_ONLY, IDEMPOTENT, DEDUPLICATABLE, NON_IDEMPOTENT or
EXTERNAL_IRREVERSIBLE.

Retry/recovery is constrained by that classification and by invocation records/verification.

## Storage rule

SQLite stores bounded operational metadata.

Large output/artifacts are external referenced blobs/files.
Secrets, raw prompts and unbounded terminal/file contents are not durable state payloads.

## Consequences

Positive:

- one recovery substrate for all V3 long-running work;
- atomic crash-safe state transitions;
- simple local deployment;
- future Storage backend can replace SQLite without changing domain contracts.

Cost:

- P05 must implement a small state-machine/event framework;
- schema migration and crash tests become first-class engineering work;
- distributed durability is not automatically provided and must be added at a higher layer if needed.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/research/V3_TECHNICAL_RESEARCH.md
- https://www.sqlite.org/atomiccommit.html
- https://www.sqlite.org/wal.html
- https://docs.temporal.io/
- https://restate.dev/
