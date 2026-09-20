# ADR-0013 — V3-A Execution & Agent Foundation

Status: Accepted
Date: 2026-09-20

## Context

Foundation V2 established Workspace, Capability, Policy, Execution Runtime, Audit/Recovery and Plugin contracts.

The first V3 implementation work introduces persistent Process/Terminal Sessions and will later host concrete local
Agents. The current prototype correctly demonstrates command/terminal lifecycle behavior, but it also reveals two
architectural risks if expanded directly:

1. long-lived execution can accidentally depend on process-wide mutable active-Workspace state;
2. one ProcessRuntime can become responsible for lifecycle, persistence, PowerShell spawning, Windows process control,
   Workspace binding and eventually Agent behavior.

Both would make concurrent Agents difficult to reason about and would leak host-specific implementation details into
the generic Agent contract.

## Decision

Adopt V3-A as the first V3 implementation slice.

V3-A introduces five explicit concepts:

1. Execution Context — immutable execution identity/scope.
2. Session Manager — generic long-lived lifecycle/event/recovery owner.
3. Process Driver — host-specific process execution adapter.
4. Isolation Manager — worktree/session-root allocation and reconciliation boundary.
5. Agent Runtime — generic actor lifecycle with concrete Agent Provider Plugins.

Foundation V2 remains stable and is extended rather than redesigned.

## Execution Context decision

Interactive MCP calls may capture the active Workspace at call start.

Long-lived Sessions and Agents MUST persist their captured Workspace/actor/isolation identity and MUST NOT resolve
their identity from a later mutable `WorkspaceManager.current()` value.

## Process decision

PowerShell and Windows process mechanics are implementation details.

They belong behind a Process Driver such as `LocalPowerShellDriver`. Session Manager owns lifecycle and recovery, not
`spawn`, PowerShell arguments or `taskkill.exe`.

## Isolation decision

Writing Agents use isolated mutable roots by default.

For Git Workspaces, the default isolation primitive is a dedicated worktree per writing Agent Session. Isolation does
not expand authorization and is not considered an OS sandbox.

## Agent decision

Concrete Agents are Provider Plugins over the generic Agent Runtime.

Provider-specific executable, prompt, CLI and transport details MUST NOT leak into Skills or generic Agent contracts
and MUST NOT bypass Core Policy / Execution Runtime / Audit.

## Delivery decision

V3-A stops after the execution substrate and one reference Agent Provider are stable.

Verified Assets, Meta-Capabilities, Skills and Orchestrator remain accepted V3 target architecture but are deferred
until V3-A acceptance criteria pass.

## Consequences

Positive:

- concurrent Agent work does not depend on a global Workspace pointer;
- process/session behavior becomes reusable by Agents and future workers;
- host-specific PowerShell behavior can later be replaced by Broker/container/remote drivers;
- worktree isolation becomes a first-class primitive instead of Agent-specific glue;
- upper V3 layers can build on stable execution contracts.

Cost:

- current ProcessRuntime prototype must be decomposed before it becomes a permanent API;
- explicit context propagation adds plumbing to runtime calls;
- session and audit correlation must be designed rather than treating them as the same state machine;
- V3 feature breadth is intentionally delayed.

## Rejected alternatives

### Extend current ProcessRuntime directly into AgentRuntime

Rejected because it would couple Agent semantics to PowerShell/Windows process mechanics and mutable Workspace access.

### Build Skills/Orchestrator now and refactor the substrate later

Rejected because upper-layer workflow contracts would be forced to encode unstable session, isolation and actor
semantics.

### Make every Agent a standalone plugin with its own lifecycle/isolation

Rejected because lifecycle, isolation, authorization and recovery are cross-cutting platform concerns and would drift
between providers.

## References

- `docs/architecture/TARGET_ARCHITECTURE_V3A.md`
- `docs/architecture/TARGET_ARCHITECTURE_V3.md`
- `docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md`
- `docs/adr/ADR-0012-agent-skill-orchestrator.md`
