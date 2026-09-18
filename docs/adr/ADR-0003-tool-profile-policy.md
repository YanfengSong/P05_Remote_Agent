# ADR-0003: Gate tool exposure behind tool profiles

Status: Accepted  
Date: 2026-09-18

Superseded detail: an earlier draft of this change added a second key (local unlock
flags such as `P05_ENABLE_SHELL`) on top of the profile. That was dropped in favour of
the execution plan's model — profile-only exposure, with approval deferred to TASK-012
— so the implemented behaviour matches TASK-001's definition of done. The reasoning
below reflects the implemented decision.

## Context

V0.2 registered all tools unconditionally. ADR-0001 left ingress — Streamable HTTP, and
later a remote client such as ChatGPT through an OpenAI Secure MCP Tunnel — as a later
deliverable, which means the tool surface would have been handed to a remote model
before any policy decision was made.

Two tools are not safe to expose by default:

- `shell_run` constrains `cwd` to the allowed roots but not the command, so
  `Get-ChildItem C:\`, `Get-ItemProperty HKLM:\...`, `net use \\host\share` and
  `Invoke-WebRequest` are all reachable. The command blocklist in `src/security.ts`
  is a speed bump, not a boundary (one of its rules was in fact dead — see below).
- `mcp_call_tool` proxies to a downstream MCP server. With MATLAB that is arbitrary
  code evaluation — an equivalent execution surface reached through a different door,
  so hiding `shell_run` alone would have achieved nothing.

`fs_write` inside an allowed root is a third path to execution: writing
`.git/hooks/pre-commit` or `.git/config` turns a text write into code that git runs on
the next operation.

## Decision

Tool exposure is a property of a profile, declared in `src/policy/tool-profile.ts` and
applied at registration time by `src/policy/expose.ts`.

1. Every exposable tool declares a `minProfile` and a `risk`. Nothing is registered
   unless declared; an undeclared name throws.
2. Four cumulative profiles: `discovery` < `readonly` < `developer` < `full`.
   `discovery` is the default; `full` must never be the default.
3. A suppressed tool is **not registered at all** — it never appears in `tools/list`,
   so a remote client cannot discover it. Registration-time gating, not call-time
   filtering.
4. An unrecognised profile value aborts startup. No silent fallback (plan rule 3.4).
5. Paths that convert a file write into code execution, or that hold credentials, are
   refused even inside an allowed root, and the resolved real path is re-checked so a
   symlink or junction inside a root cannot escape it.

## Consequences

Positive:

- the next ingress cannot accidentally publish an execution surface; the default state
  is a two-tool discovery surface;
- an invalid configuration fails loudly instead of widening access;
- the exposed surface is one readable table, reviewable before the tunnel is connected;
- adding a later tool (`fs_search`, git tools, `process_start`, `batch_execute`) now
  requires an explicit profile and risk decision rather than inheriting exposure.

Trade-offs:

- every new tool must be declared before it can be exposed;
- the `readonly` profile is incomplete until TASK-004/TASK-005 deliver `fs_search` and
  the git tools — the plan's lists cannot be satisfied by tools that do not exist;
- `developer` is a trusted-profile level: it includes file writes and downstream MCP
  calls. That is the plan's intent, and the gateway to it is the profile value itself;
- `mcp_call_tool` inherits the downstream server's capability surface, so its profile
  placement is a coarse control.

## Follow-up (later plan tasks)

- TASK-009: rework command policy; the `Remove-Item -Recurse -Force` rule was dead
  because `\b` sits between a space and `-` with no word boundary — fixed, but the
  whole blocklist needs the planned rework;
- TASK-010: structured audit log of every tool call;
- TASK-012: approval model, which is where "approved Git mutations" and "approved
  downstream MCP wrappers" from the profile tables become real;
- TASK-006/007: process manager and batch execution, which reduce the need for
  `shell_run` altogether.
