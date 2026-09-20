# ADR-0014 — Protocol Edge and Explicit Application Handles

Status: Accepted as V3 target architecture
Date: 2026-09-20

## Context

MCP 2026-07-28 removed protocol-level sessions and moved toward a stateless request model. Long-running work is
represented through explicit handles and the optional Tasks extension.

P05 already has application concepts that live longer than one MCP request:

- Process/Terminal Session;
- Agent Session;
- Skill Run;
- Task Run;
- Search Run;
- approvals and reconciliation.

Binding these to a transport session would make P05 lifecycle semantics depend on one protocol revision and would make
reconnect/multi-client/multi-device behavior fragile.

## Decision

MCP is a Protocol Edge adapter.

P05 application state uses explicit P05 identifiers/handles. Protocol adapters map those handles to protocol-specific
representations.

Rules:

1. MCP Session identity is never canonical P05 application identity.
2. MCP Task, when supported, maps to a P05 Run.
3. A client without MCP Tasks can use explicit status/output/cancel operations over the same Run.
4. Protocol reconnect does not retarget or recreate a P05 Run.
5. Protocol versioning is handled at the edge.
6. MRTR/input-required can surface P05 waiting-input/approval state but does not own it.
7. Authentication identity and trace context are imported into stable P05 Context/Audit models.
8. Protocol Edge contains no application business logic.

## Consequences

Positive:

- P05 survives future MCP protocol changes;
- application state is explicit and inspectable;
- reconnect and multi-client use are tractable;
- long-running execution is not hidden in transport state.

Cost:

- adapters must translate between protocol task/result shapes and P05 Runs;
- compatibility code may be needed for multiple MCP revisions.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/research/V3_TECHNICAL_RESEARCH.md
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
