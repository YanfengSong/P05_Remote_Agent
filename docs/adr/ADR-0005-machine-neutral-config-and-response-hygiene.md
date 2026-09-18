# ADR-0005 — Machine-neutral configuration and response hygiene

Status: accepted (2026-09-18, pre-merge review of `feat/remote-agent-v03`)

## Context

A pre-merge review of the TASK-001 / TASK-002 work raised five points, all of which are
about what this repository exposes once it leaves one machine — either to a second
machine, or to a remote client over a tunnel.

1. `src/config.ts` shipped `DEFAULT_ROOTS = ["F:\\Project_Git"]`, and `.env.example`
   named `D:\Tools\matlab-mcp-server\...` and `D:\Program Files\MATLAB\R2024b`. None of
   those are portable, and the first of them is a **silent capability default**: on
   another machine it either refuses every path or frees a directory that no operator
   chose.
2. `mcp_call_tool` — a generic proxy — sat at the `developer` profile, while plan
   section 3 lists it under 禁止一开始暴露 ("never expose initially") next to
   `shell_run`, and reaches MATLAB code evaluation through the downstream server.
3. Successful responses carried resolved absolute paths. `fs_write` returned the
   resolved path (so a relative request disclosed the server's working directory),
   `shell_run` echoed the resolved working directory (the configured default when the
   caller omitted `cwd`), and `mcp_status` carried the raw downstream spawn error, which
   contains the absolute command path.
4. `PROJECT_STATUS.md` still claimed the branch had never been pushed.
5. The version was `0.2.0` in three places and `0.1.0` in two others, while the documents
   called the stage V0.3.

## Decision

**No machine-specific default exists in code or in `.env.example`.**

- `REMOTE_AGENT_ALLOWED_ROOTS` is required. Unset aborts startup with a non-zero exit
  code, exactly like set-but-empty; the error says the agent ships no default root. This
  is the same fail-closed reading of plan rules 3.4 / section 8.1 that already covered
  the empty case, now applied to the unset case it was hiding behind.
- The MATLAB downstream is opt-in (`MATLAB_MCP_ENABLED=false`) and has no default
  command, args or MATLAB root. A machine without MATLAB reports `enabled: false` rather
  than arming a server that cannot start.
- The downstream child's `WINDIR` is inherited from the environment instead of assuming
  `C:\Windows`.
- Test fixtures derive the allowed root from the repository's own location, so the suite
  runs from any checkout.

**The generic downstream proxy is a `full` tool.** `mcp_call_tool` moves from `developer`
to `full`, next to `shell_run`. Rationale: it is not a capability this repository
implemented, it is a pipe to whatever the downstream server implements, and the plan's
own "never expose initially" list names it. The consequence is deliberate and temporary:
`developer` has **no** way to reach the downstream server until the purpose-built
wrappers of TASK-013 land, at which point those wrappers belong in `developer` and the
generic proxy stays at `full`. `mcp_status` and `mcp_list_tools` stay at `developer`:
they report configuration and enumerate tools, they do not invoke anything.

**A successful response carries no resolved absolute path.** The caller's own input is
echoed instead:

- `fs_write` returns `{ bytes }`; the handler echoes the caller's `path`;
- `shell_run` returns stdout/stderr only, and echoes the caller's `cwd` when supplied;
- `mcp_status.lastError`, and the error text of `mcp_list_tools` / `mcp_call_tool`, carry
  a short category (`command not found`, `access denied`, `timed out`,
  `connection refused`, `connection failed`) instead of the raw spawn error; the operator
  keeps the real message on stderr.

The rule is deliberately stated as a closed list rather than a guarantee: file contents
and downstream tool output remain pass-through by design, which is exactly why the
generic proxy sits at `full`.

**One version.** `src/version.ts` holds `VERSION`, used by the MCP server identity, the
downstream client identity and the mock server; `package.json` is set to `0.3.0` and a
test asserts that the two agree, so they cannot drift again.

## Consequences

- To run the agent, the operator must now state the allowed roots. Copying
  `.env.example` verbatim will not start the server — intentionally, and asserted by a
  test. `start-local.ps1` therefore also requires the variable to be present.
- Anyone reusing the earlier "developer profile can call MATLAB" behaviour must use
  `full` now (or wait for TASK-013).
- Remote clients receive slightly less diagnostic detail on downstream failures; the
  operator's stderr keeps it.
- Existing assertions in `policy-profiles.ts` / `profile-exposure.ts` were updated to the
  new matrix, and new ones were added for each decision above: unset roots exit
  non-zero, a relative write echoes the caller's path and not the resolved one,
  `shell_run` without `cwd` does not disclose the default directory, a downstream
  failure neither carries the command path nor loses its category, and
  `package.json` matches `src/version.ts`.

## Not decided here

- Hard links and the TOCTOU window remain as documented in ADR-0004.
- Command policy rework stays with TASK-009; approval and audit stay with
  TASK-010 / TASK-012.
- Whether `mcp_status` should report `configured` at all (it reveals that *some*
  downstream server is configured, not which path) is left as is.
