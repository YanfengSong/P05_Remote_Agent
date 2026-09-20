# ADR-0008 — Developer Shell Trust Model

Status: Accepted
Date: 2026-09-20

## Context

P05 is intended to approach Remote Desktop Commander in day-to-day remote development ergonomics.
Structured tools are safer and easier to audit, but they cannot cover every engineering operation without
continually expanding the MCP tool surface.

Remote Desktop Commander explicitly treats terminal execution as a first-class capability. Its security model
states that terminal commands run with the paired user's operating-system permissions and that directory
allowlists / command blocking are guardrails rather than a sandbox.

P05 previously kept `shell_run` at the `full` profile.

## Decision

Expose `shell_run` at the normal `developer` profile.

The tool:
- runs PowerShell as the paired Windows user;
- accepts `command`, optional `cwd`, and optional timeout;
- requires the starting cwd to pass the configured allowed-root guard;
- applies the existing destructive-command blocklist as accident prevention;
- is explicitly documented as **not a sandbox**.

The `full` profile remains meaningful because the generic downstream proxy `mcp_call_tool` stays there.

## Authorization model

Technical fact:
- once `shell_run` is available, the command can access any resource available to the Windows user, regardless
  of filesystem-tool allowed roots.

Operational contract for this project:
- work inside the authorized P05 workspace may proceed autonomously;
- persistent modifications outside the authorized workspace require explicit user approval;
- system/service/registry/firewall and other host-level policy changes should use explicit approval or a narrow
  external broker when a repeatable operation exists.

The operational contract is an AI/user workflow rule. It is not represented as a technical shell sandbox.

## Consequences

Positive:
- RDC-like terminal flexibility;
- fewer MCP schema additions for ordinary engineering work;
- Git, package, build and diagnostic operations can be performed without creating a tool for every command;
- structured tools remain available for safer/repeatable common paths.

Risk:
- a trusted or compromised AI client can issue commands with the paired user's permissions;
- allowed-root and blocklist controls cannot confine arbitrary PowerShell;
- prompt injection or account compromise has a larger blast radius than a structured-tools-only developer profile.

For a hard security boundary, run the execution environment inside Docker, a VM, dev container, restricted account
or dedicated workstation.

## Verification requirements

- `developer` advertises `shell_run`;
- `readonly` and `discovery` do not advertise it;
- `full` is developer + generic `mcp_call_tool`;
- shell cwd still passes the filesystem guard;
- a junction cwd escaping the allowed root is refused;
- full repository verification remains green.
