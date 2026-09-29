# ADR-0008 — Developer Shell Trust Model

Status: Retired / Superseded by ADR-0020
Date: 2026-09-20
Retired: 2026-09-22

## Context

P05 originally exposed `shell_run` at the normal `developer` profile to approach
Remote Desktop Commander-style terminal ergonomics.

The tool runs PowerShell as the paired Windows user. Its starting cwd is checked
against the active Workspace, but PowerShell itself is not sandboxed. Once shell
execution is available, commands can access resources available to that Windows
user even when structured filesystem tools would reject the same path.

## Historical decision

The original decision was:

- `developer` exposes `shell_run`;
- cwd is checked against the active Workspace;
- destructive-command patterns provide accident prevention;
- shell authority remains trusted-user and is explicitly not a sandbox.

This improved engineering flexibility but did not technically enforce the project
rule that persistent modification outside the active Workspace requires explicit
human approval.

## Why this ADR is retired

Operational experience demonstrated that a developer-profile shell can bypass the
structured Workspace boundary and perform host filesystem mutation through commands
that are semantically equivalent to otherwise suppressed structured capabilities.

The destructive-command blocklist is only a guard rail and cannot enumerate every
PowerShell, cmd.exe, .NET or external-program path that can mutate the host.

Therefore `developer` must no longer expose unrestricted `shell_run`.

## Current decision

`shell_run` is no longer exposed as an unrestricted developer shell. ADR-0019 introduced the intermediate Workspace-aware Shell Approval Gate; ADR-0020 supersedes that Shell-specific architecture with the common Tool Permission Broker while retaining conservative Shell handling and one-shot Local Operator approval.

The normal `developer` profile keeps structured and allowlisted development
capabilities, including:

- Workspace-scoped filesystem mutation;
- local Git add/commit/branch operations;
- fixed `command_run` validation actions;
- fixed Runtime restart;
- downstream status/tool discovery.

The `full` profile additionally exposes unrestricted trusted-user shell,
external Git push and arbitrary downstream execution.

This is an immediate containment measure, not the final shell security boundary.
A full-profile shell still runs with the paired Windows user's authority.

## Required final boundary

The target security invariant remains:

- Active Workspace mutation may proceed autonomously under the selected profile;
- persistent filesystem mutation outside the Active Workspace requires explicit
  human approval;
- system, drive-root and unrelated-project mutation must not be possible through
  an unapproved remote command path.

Meeting that invariant for arbitrary shell execution requires OS isolation or a
local execution/approval broker capable of enforcing filesystem effects. Command
string blocklists are not sufficient.

## Verification requirements

- `developer` does not advertise or execute `shell_run`;
- `full` advertises and can execute `shell_run`;
- shell cwd still passes the Workspace path guard;
- a junction cwd escaping the Workspace is refused;
- structured developer capabilities remain available;
- full repository verification remains green.
