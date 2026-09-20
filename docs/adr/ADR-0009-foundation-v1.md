# ADR-0009 — Foundation V1: Workspace, Capability, Runtime and Audit

Status: Accepted
Date: 2026-09-20

## Context

P05 originally treated `config.defaultCwd` as both the P05 source repository and the active engineering project.
That model does not scale to P02_Vmodel and other projects and encourages each new tool to invent its own cwd,
permission and execution behavior.

## Decision

Introduce four foundation modules without replacing the working policy system in one large rewrite:

1. `src/workspace/*`
   - explicit registered workspaces;
   - session-scoped current workspace;
   - switching by logical id only.

2. `src/capability/*`
   - capability scope contract;
   - transitional adapter over current TOOL_SPECS.

3. `src/runtime/*`
   - one execution wrapper after policy approval.

4. `src/audit/*`
   - bounded, metadata-only session audit.

Existing filesystem, Git and shell tools receive the active workspace root as context.
P05-specific `command_run` and `runtime_restart` remain platform/host capabilities rather than following a
business workspace switch.

## Consequences

Positive:
- P05 source and business projects are no longer conceptually the same workspace;
- relative file operations, Git and shell share one current-workspace context;
- workspace switching cannot introduce a new arbitrary host path;
- all exposed tools can share one execution/audit entry point;
- later Process/Search/MATLAB capabilities have a stable base.

Limitations in Base V1:
- workspace registry is startup configuration, not remotely mutable;
- audit is memory-only and resets on Agent restart;
- recovery persistence is not implemented yet;
- allowed roots remain the outer host authorization perimeter;
- shell remains a trusted-user capability, not workspace sandboxing.

These limitations are explicit follow-up work, not hidden assumptions.
