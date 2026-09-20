# ADR-0016 — Host Session, Terminal, Work Isolation and Security Isolation

Status: Accepted as V3 target architecture
Date: 2026-09-20

## Context

The first Process Runtime prototype combines process start/input/output/stop, Workspace ownership, persistence and
Windows-specific process handling.

V3 must support:

- one-shot build/test commands;
- interactive local Agent CLIs;
- full process-tree cleanup;
- parallel writing Agents;
- optional hard isolation.

These are different responsibilities.

## Decision

Split the execution substrate into distinct contracts.

### Host Session

Logical execution container on one host/worker.
It may own a process tree and/or terminal and has a durable P05 Run identity.

### Process Driver

Non-interactive command execution using ordinary process I/O.

### Terminal Driver

Interactive TTY execution.

Windows reference direction is ConPTY/node-pty or equivalent.

### Process Tree Supervisor

Windows implementation should POC Job Objects for reliable descendant lifecycle and resource control.

### Work Isolation Manager

Protects mutable engineering state.

Git writing Agents default to dedicated worktrees.

### Security Isolation

Separate execution modes:

- trusted-host;
- constrained-host;
- isolated-worker.

A worktree is never considered a sandbox.

## Restart semantics

Each Driver declares whether a live execution is:

- non-resumable;
- inspectable;
- reattachable;
- externally durable.

A normal P05-owned local PTY/process may become INTERRUPTED after P05 restart.
A Broker/Worker-backed session may reattach only if the Driver proves identity and ownership.

## Consequences

Positive:

- interactive CLI support does not distort process APIs;
- work collision and security boundaries are modeled honestly;
- future Sandbox/VM/remote workers fit without changing Agent contracts;
- Agent Runtime depends on generic sessions rather than PowerShell implementation details.

Cost:

- more explicit interfaces;
- likely native/sidecar work for Windows Job Objects;
- ConPTY/node-pty needs compatibility/security validation.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/research/V3_TECHNICAL_RESEARCH.md
- https://github.com/microsoft/node-pty
- https://learn.microsoft.com/en-us/windows/console/pseudoconsoles
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://git-scm.com/docs/git-worktree
