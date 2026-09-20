# ADR-0010 — Foundation V2 Architecture

Status: Accepted
Date: 2026-09-20

## Decision

Foundation V2 replaces the transitional V1 model with the following stable contracts:

1. Workspace Context and authorization semantics are separate.
2. Exactly one platform-source workspace owns P05 self-validation.
3. Structured workspace operations cannot cross the active workspace.
4. Core capability metadata has one canonical catalog.
5. Tool registration is modular; index.ts is assembly only.
6. All exposed tools run through the common execution lifecycle.
7. Audit metadata persists in protected P05 state and supports interrupted-run recovery.
8. Applications integrate as plugins.
9. Downstream MCP processes are workspace-binding aware.
10. Git local mutations are developer capabilities; Git push remains full because it is an external mutation.

## Shell exception

`shell_run` remains an explicit trusted-terminal capability.

P05 constrains its starting cwd but does not claim that PowerShell itself is confined to the workspace.

The operating rule that persistent outside-workspace modification requires user approval remains valid, but a hard technical shell boundary requires OS isolation or an external execution/approval broker.

## Consequence

Process, Search, MATLAB adapters and future capabilities should now extend the foundation rather than alter these contracts.
