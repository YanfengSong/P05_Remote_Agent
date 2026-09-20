# Remote Desktop Commander Benchmark

Updated: 2026-09-20

## Purpose

P05 Remote Agent uses Remote Desktop Commander (RDC) as an operational benchmark, not as a security blueprint.
The target is RDC-like development ergonomics with a stricter permission boundary for self-modifying automation.

## What RDC does well

Public RDC documentation describes a remote MCP relay from an AI client to a paired device agent. The agent can
work with files, terminals, processes and development environments on the real machine. Pairing uses an OAuth
device flow; a device is reachable while its agent is running and can be revoked from the dashboard.

The open-source Desktop Commander tool engine exposes a broad, ergonomic inventory:
- files: read, multi-read, write, edit, move and directory operations;
- search: start/paginate/stop searches;
- process: start, interact, output, sessions and termination;
- configuration/diagnostics: configuration and recent tool calls.

This interaction model is the main P05 reference: use structured tools for common operations, keep long-running
work local, and return bounded results instead of forcing the AI to emulate a terminal one command at a time.

## RDC security model

RDC and Desktop Commander explicitly document an important limitation:
- tools run with the paired user's operating-system permissions;
- allowed directories and blocked commands are guardrails, not a security boundary;
- a terminal can reach outside filesystem-only directory restrictions;
- strong containment requires an OS boundary such as Docker, a VM, dev container or dedicated machine.

This is an important design lesson for P05. A raw shell plus an allowed-root string does not create a trustworthy
workspace boundary.

## P05 decisions

P05 adopts these RDC patterns:
1. A stable remote MCP entry point paired with a local device runtime.
2. Structured filesystem, Git, process and search tools.
3. Long-running process/session primitives instead of repeated shell polling.
4. Bounded output and pagination/tail semantics.
5. Device-level reachability that can be stopped/revoked independently of the AI conversation.
6. High-level task wrappers for common development workflows.

P05 deliberately differs in these areas:
1. The remotely reachable developer profile exposes raw shell, matching RDC's trusted-client model, but P05 documents it explicitly as user-account-level authority rather than a workspace sandbox.
2. Security-critical host policy must not be writable by the same AI-controlled workspace.
3. Workspace file tools are path-confined and protected paths are denied, but this is still treated as a guardrail
   against file-tool mistakes, not as a complete OS sandbox.
4. Host-level effects use narrow external brokers. The first example is P05-RestartBroker: the AI can request
   restart, but cannot create, reconfigure or parameterize the broker.
5. Self-modification and self-authorization are separate: P05 may evolve code in its workspace, but cannot silently
   grant itself new host permissions.
6. `shell_run` is a developer capability; the generic downstream `mcp_call_tool` remains a full-profile escape hatch.

## Capability roadmap derived from the benchmark

Priority order:
1. fs_search + richer bounded file reads.
2. git_log / git_branch plus reviewed Git mutations.
3. process_start / process_wait / process_output / process_stop, scoped to P05-owned sessions.
4. batch_execute / run_task to reduce remote tool-call count.
5. audit records with bounded metadata and no secret content.
6. external approval/broker path for host-level or out-of-workspace changes.
7. purpose-built MATLAB/Simulink wrappers rather than generic downstream execution.
8. optional OS sandbox/worker isolation for commands that must execute arbitrary repository code.

## Sources

- Remote Desktop Commander repository and trust model:
  https://github.com/desktop-commander/remote-desktop-commander
- Remote Desktop Commander security policy:
  https://github.com/desktop-commander/remote-desktop-commander/blob/main/SECURITY.md
- Desktop Commander open-source tool inventory:
  https://github.com/wonderwhy-er/DesktopCommanderMCP
- Desktop Commander security model:
  https://github.com/wonderwhy-er/DesktopCommanderMCP/security

These sources are external references only. P05's enforced behavior is defined by this repository's code,
architecture documents and ADRs.