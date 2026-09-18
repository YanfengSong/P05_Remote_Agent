# ADR-0003: Gate tool exposure behind a profile ceiling plus local unlock flags

Status: Accepted  
Date: 2026-09-18

## Context

V0.2 registered all nine tools unconditionally. ADR-0001 left ingress — Streamable
HTTP, and later a remote client such as ChatGPT through an OpenAI Secure MCP Tunnel —
as a V0.3 deliverable, which means the tool surface would have been handed to a remote
model without a policy decision ever being made.

Two of those tools are not safe to expose:

- `shell_run` constrains `cwd` to the allowed roots but not the command, so
  `Get-ChildItem C:\`, `Get-ItemProperty HKLM:\...`, `net use \\host\share` and
  `Invoke-WebRequest` are all reachable. The command-string blocklist in
  `src/security.ts` is a speed bump, not a boundary.
- `mcp_call_tool` proxies to a downstream MCP server. With the MATLAB server that is
  arbitrary code evaluation — an equivalent execution surface reached through a
  different door, so gating `shell_run` alone would have achieved nothing.

`fs_write` inside an allowed root is a third path to execution: writing
`.git/hooks/pre-commit` or `.git/config` turns a text write into code that git runs on
the next operation.

## Decision

Tool exposure is decided by a catalog in `src/policy/spec.ts`, applied at registration
time by `src/policy/expose.ts`.

1. Every tool declares `minProfile` and `risk`. Nothing is registered unless declared;
   `expose()` throws on an undeclared name.
2. Exposure requires **two keys**: the profile ceiling
   (`P05_TOOL_PROFILE` ∈ `safe` < `dev` < `full`, default `safe`) *and*, for every
   `write`/`execute` tool, an explicit local unlock flag.
3. A suppressed tool is **not registered at all** — it never appears in `tools/list`,
   so a remote client cannot discover it.
4. An unrecognised profile value aborts startup. No silent fallback.
5. Paths that convert a file write into code execution, or that hold credentials, are
   refused even inside an allowed root.

## Consequences

Positive:

- the V0.3 ingress cannot accidentally publish an execution surface; the default state
  is read-only;
- escalating the profile is not enough to arm `shell_run`, so a remote-writable config
  value is not a single point of escalation;
- the exposed surface is one readable table, reviewable before the tunnel is connected;
- adding a later tool (`run_command`, `process_start`, git tools) now requires an
  explicit profile and risk decision rather than inheriting exposure by accident.

Trade-offs:

- every new tool must be declared before it can be exposed — an unregistered tool fails
  loudly at startup;
- an operator who wants a full local session must set profile *and* unlock flags;
- the unlock flags are process-wide, so a daemon that reaches a tunnel must not carry
  them; per-call approval would be the finer-grained successor;
- `mcp_call_tool` inherits the downstream server's capability surface, so its unlock
  flag is a coarse control.

## Follow-up (later V0.3 phases)

- structured audit log of every tool call, including suppressed attempts;
- optional approval hook for `write`/`execute` tools;
- process lifecycle tools that replace `shell_run` for the common cases, reducing the
  need to unlock execution at all.
