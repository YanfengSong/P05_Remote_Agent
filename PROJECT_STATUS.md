# Project Status

Updated: 2026-09-18

Governing plan: `docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md` (Chinese) and
`docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md` (English). The local AI agent executes one
TASK at a time and stops.

## Current baseline

Version: V0.3 — TASK-001 Tool Profile Safety and TASK-002 Local Startup complete  
Branch: `feat/remote-agent-v03`  
Canonical repository: `YanfengSong/P05_Remote_Agent`  
Validated on Windows with Node.js 22.23.1.

Milestones:

```text
V0.3-A Device Discovery        done
V0.3-B Local HTTP              done
V0.3-C Secure Tunnel           not started
V0.4   Readonly Remote Agent   not started
V0.5   Developer Agent         not started
V0.6   Efficient Agent         not started
V0.7   MATLAB                  not started
```

## TASK-001 — Tool Profile Safety

Implemented:

- `P05_TOOL_PROFILE` with four cumulative profiles `discovery` < `readonly` <
  `developer` < `full`; default `discovery`; `full` is never the default;
- every exposable tool declared in `src/policy/tool-profile.ts` with a minimum profile
  and a risk; an undeclared tool cannot be registered;
- tools registered conditionally by `src/policy/expose.ts`, so a suppressed tool never
  appears in `tools/list` and cannot be discovered by a remote client, with a call-time
  re-check as defence in depth;
- an unknown profile value aborts startup with a non-zero exit code (fail closed);
- protected paths (`.git`, `.p05`, credentials, `.env`) refused even inside an allowed
  root, plus path-shape and real-path checks that defeat UNC / `\\?\` /
  drive-relative / alternate-data-stream / symlink / junction / trailing-dot spellings;
- startup exposure report on stderr (stdout is the JSON-RPC channel);
- `npm run verify` pipeline and profile tests, including the TASK-001 DoD verbatim.

Fixed along the way:

- the `Remove-Item -Recurse -Force` command rule was dead — `\b` between a space and
  `-` is not a word boundary, so it never matched. The pattern is corrected and now
  asserted by a test. The wider command-policy rework remains TASK-009.
- default allowed root was `D:\Project_Git;D:\Project_Boonray`; neither exists on this
  machine. Set to `F:\Project_Git`.
- the fs tools now refuse `.git` writes, which would otherwise become code execution on
  the next git operation, and re-check the resolved real path so a symlink or junction
  inside an allowed root cannot escape it.

Validation:

```text
npm run check           pass (tsc --noEmit)
npm run build           pass
npm run test:policy     POLICY_PROFILES_OK (142 checks)
npm run test:exposure   PROFILE_EXPOSURE_OK (92 checks)
npm run smoke:downstream DOWNSTREAM_SMOKE_OK
```

TASK-001 DoD, verified end to end: with `P05_TOOL_PROFILE=discovery`, `tools/list`
returns exactly `device_info` and `ping`; `shell_run`, `fs_write` and `mcp_call_tool` are
absent and uncallable.

Deviations from the plan, deliberate and recorded:

- the plan's `readonly` list includes `fs_search`, `git_status`, `git_diff`, `git_log`
  and `developer` includes `apply_patch`, `process_*`, `batch_execute`. None of these
  exist yet (TASK-004/005/006/007), so they are recorded in `PLANNED_TOOLS` and are not
  exposed. The profiles expose the implemented subset only.
- `mcp_call_tool` is placed in `developer` to match the plan's "approved downstream MCP
  wrappers"; the word *approved* is the TASK-012 approval model, which does not exist
  yet, so today the profile value alone is the gate. Flagged as a risk below.

## TASK-002 — Local Startup Standardization

Implemented:

- `scripts/start-local.ps1`: checks Node, checks/creates dependencies, builds, resolves
  the tool profile (command line > environment > `.env` > `discovery`), validates it,
  refuses a port that is already in use, prints the device/profile/MCP/health banner and
  starts the Streamable HTTP gateway;
- `-Profile`, `-Port`, `-Probe` switches; `-Probe` starts the gateway, waits for
  `/healthz` and stops it again, which makes the pre-tunnel check repeatable;
- `scripts/verify.ps1`: runs the section 20 pipeline and prints one PASS/FAIL summary,
  ending in `VERIFY_OK` or `VERIFY_FAILED`, plus a working-tree hygiene line;
- `npm run start:local`, `npm run verify:win`; `npm run start:http` is unchanged.

Validation:

```text
scripts/verify.ps1                  VERIFY_OK (5 steps, 8s)
scripts/start-local.ps1 -Probe      banner correct, /healthz 200 on a free port,
                                    port released afterwards
busy port                            refused with the owning PID and start time
over HTTP (real MCP client)          tools/list -> device_info, ping
                                     ping -> ok=true, hostname XiaoiWu
                                     device_info -> deviceId p05-1362e78d-...
                                     shell_run -> refused, "Tool shell_run not found"
```

The HTTP result is the shape the plan's section 7 expects from ChatGPT, so the local
half of that acceptance path is already proven; only the tunnel itself is missing.

## Security hardening — adversarial review findings

An independent reviewer (own workspace, real NTFS fixtures, raw JSON-RPC client, no SDK)
attacked the gate and the path policy. Result: **the gate holds, the path policy did not.**

Held, reproduced as counter-evidence:

- fuzzed `P05_TOOL_PROFILE` values (case, tabs/newlines, Unicode whitespace, `dev;full`,
  `0/1/true/admin/root/off`) → normalised to an equivalent profile or exit 1;
- suppressed tools called directly (case variants, empty name, embedded NUL, **duplicate
  JSON-RPC keys**) → `Tool not found`;
- type confusion and `__proto__`/`constructor` injection into `arguments` → stripped by zod;
- every declared tool goes through `expose()` — no tool is registered around the gate;
- shape attacks (ADS, `\\?\`, UNC, drive-relative, trailing dot/space, case, sibling-prefix
  directory) and non-dangling junctions (including a chain and one to `C:\Windows`) → refused.

Fixed (each now asserted by a test that builds the real fixture):

| Finding | Fix |
|---|---|
| A **dangling junction** skipped the containment check: the unresolved-path fallback made `real === resolved`, and the write landed outside the roots once the target appeared | the first existing component must canonicalise; a link that cannot be resolved is refused (ADR-0004) |
| `fs_write` could overwrite `dist/**`, `node_modules/**`, `package.json`, `tsconfig.json`, `.vscode/tasks.json`, `.mcp.json` — code that runs on the next start or install, reachable at `developer` with no second gate | write-side code-execution paths refused |
| `shell_run`'s `cwd` was string-checked only, so a junction in the root ran the command outside it | `cwd` goes through the same guard |
| Refusals echoed absolute paths, the working directory and link targets to the remote | refusals echo the caller's input and the rule only |
| `process.env` was read with inherited properties, so a polluted prototype could answer for `P05_TOOL_PROFILE` | `Object.hasOwn` |

Deferred with reasons (see ADR-0004):

- **hard links** — the reviewer reproduced one inside an allowed root reading a `.env` and
  a private key. Detecting them needs `fstat().nlink`, which also breaks pnpm-style
  hard-link toolchains;
- **TOCTOU** between the check and `open()` — needs open-then-verify-by-handle semantics;
- **command blocklist** — bypassable by option order, aliases, `rd /s /q`, `cmd /c del`,
  cmdlet obfuscation. It is an accident guard, not a boundary; TASK-009 owns the rework;
- `mcp_list_tools` spawns a local process but is declared `risk: "read"` — a risk-label
  inaccuracy (the command comes from local env, so a remote client cannot choose the
  binary); worth correcting when TASK-013 wires the MATLAB server.

## Known risks

- `shell_run` is not a sandbox and is reachable at `full`. Do not run `full` on any
  daemon reachable by a remote client before TASK-010 (audit) and TASK-012 (approval).
  Its `cwd` is now guarded, but the command it runs is not confined.
- `mcp_call_tool` at `developer` reaches downstream MCP capability, i.e. MATLAB code
  evaluation, without any approval step.
- Path hardening cannot see hard links (reproduced as a read of `.env` and a private key
  through a pre-existing hard link), and a TOCTOU window remains between the path check and
  the file operation.
- The agent can no longer write its own manifests or dependencies (`package.json`,
  `tsconfig.json`, `package-lock.json`, `node_modules/**`, `dist/**`) — that is deliberate,
  since writing them is equivalent to executing code; it needs a local action or the
  TASK-012 approval path.
- No structured audit log yet.

## Workspace

Working tree: `F:\Project_Git\P05_Remote_Agent`  
Allowed roots default to `F:\Project_Git`. The legacy `D:` path is not used by this
project.

## Open items for the user

- `feat/remote-agent-v03` has not been pushed: neither WSL git nor the Windows git has a
  credential helper, so the push stops for credentials rather than hunting for a token.
- A node process started 2026-09-18 19:48 is still listening on 127.0.0.1:8765 (a
  gateway from the earlier V0.3-B verification). `start-local.ps1` now refuses that port
  until it is stopped, and probes must use a free port.
- `docs/roadmap/` and `docs/deployment/` plan documents arrived on `main` during
  TASK-001 (commits `7d05c6c`, `fafac2a`); this branch is rebased onto them.
