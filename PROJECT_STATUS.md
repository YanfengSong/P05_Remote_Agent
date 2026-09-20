# Project Status

Updated: 2026-09-20

Governing plan: `docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md` (Chinese) and
`docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md` (English). The local AI agent executes one
TASK at a time and stops.

## Current baseline

Version: 0.3.1 — TASK-001 Tool Profile Safety, TASK-002 Local Startup, the pre-merge review
fixes, and the temporary read-only layer (TMP-R01..TMP-R06)
Branch: `feat/remote-agent-v03`, pushed to `origin/feat/remote-agent-v03`
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

## TMP — temporary read-only layer (2026-09-20)

Requested capability: let a remote client read this repository's documents and source so it can
review them, without granting anything else. Approved as a **temporary** layer only; the
Self-Development Bootstrap design (`D:\Project_Git\_p05_deploy\BOOTSTRAP_V1_DESIGN.md`) is a
separate, not-yet-implemented phase, and this layer must not grow into the permission model.

Implemented:

- `list_directory` and `read_file` in `src/tools/temp-readonly.ts` — the module contains no
  write, delete, move or process-spawning code path at all;
- opt-in gate `P05_TEMP_READONLY_ROOT`: the two tools are declared in
  `src/policy/tool-profile.ts` with `gate: "temp-readonly"`, and the gate is evaluated before the
  profile rank, so with the variable unset the startup report lists both as suppressed and
  `tools/list` is still exactly `device_info` + `ping` (TASK-001 DoD preserved);
- confinement: every path goes through the existing `assertAccessiblePath` guard (path shape,
  allowed root, protected names, real path) and is then re-checked against the temporary root,
  including its resolved real path — so `..`, a junction leaving the root, and a sibling of the
  temporary root inside the allowed roots are all refused (TMP-R02, TMP-R03);
- credential filter on top of the guard's own rules: `.env*` (templates excepted), `*.key`,
  `*.pem`, `*.pfx`, `*.p12`, `*.kdbx`, `*.jks`, `*.keystore`, `*.ppk`, `*.asc`, `*.crt`, `*.der`,
  `secrets`/`credentials` path segments, and separator-anchored `token`/`secret`/`password`/
  `api-key` file names; refusals echo the caller's input and never the root or a link target, and
  no refusal text contains the secret (TMP-R04);
- bounded read: 1 MB cap and binary (NUL-containing) files refused (TMP-R05);
- listing withholds protected and credential-like entries and reports how many were withheld;
- fail closed on a relative or out-of-root `P05_TEMP_READONLY_ROOT` (startup aborts); a blank
  value means "off", not "refuse to start";
- published on `discovery` deliberately, so enabling it needs no profile change: it is the gate,
  not the profile, that decides.

Validation (`npm run verify:win` → `VERIFY_OK`, now six steps):

```text
npm run check              pass (tsc --noEmit)
npm run build              pass
npm run smoke:downstream   DOWNSTREAM_SMOKE_OK
npm run test:policy        POLICY_PROFILES_OK (148 checks)
npm run test:exposure      PROFILE_EXPOSURE_OK (101 checks)
npm run test:temp-readonly TEMP_READONLY_OK (48 checks)
```

Deletion path when the Security Broker lands: `src/tools/temp-readonly.ts`, its spec entries in
`src/policy/tool-profile.ts`, the two `exposer.expose` blocks in `src/index.ts`, the
`test:temp-readonly` script and verify step, and the `P05_TEMP_READONLY_ROOT` line from `.env`.
ADR-0006 records the decision; no part of this layer is meant to survive it.

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
  machine. It pointed at nothing, and was replaced first by `F:\Project_Git` and then
  removed entirely (see the pre-merge review fixes below: there is no default root now).
- the fs tools now refuse `.git` writes, which would otherwise become code execution on
  the next git operation, and re-check the resolved real path so a symlink or junction
  inside an allowed root cannot escape it.

Validation:

```text
npm run check           pass (tsc --noEmit)
npm run build           pass
npm run test:policy     POLICY_PROFILES_OK (148 checks)
npm run test:exposure   PROFILE_EXPOSURE_OK (101 checks)
npm run smoke:downstream DOWNSTREAM_SMOKE_OK
scripts/verify.ps1      VERIFY_OK (5 steps, 9s)
```

TASK-001 DoD, verified end to end: with `P05_TOOL_PROFILE=discovery`, `tools/list`
returns exactly `device_info` and `ping`; `shell_run`, `fs_write` and `mcp_call_tool` are
absent and uncallable.

Deviations from the plan, deliberate and recorded:

- the plan's `readonly` list includes `fs_search`, `git_status`, `git_diff`, `git_log`
  and `developer` includes `apply_patch`, `process_*`, `batch_execute`. None of these
  exist yet (TASK-004/005/006/007), so they are recorded in `PLANNED_TOOLS` and are not
  exposed. The profiles expose the implemented subset only.
- `mcp_call_tool` is a generic downstream proxy and sits at `full`, not `developer`, even
  though the plan's profile sketch mentions downstream MCP under `developer`. Plan
  section 3 lists `mcp_call_tool` under 禁止一开始暴露 together with `shell_run`, and the
  plan's "approved downstream MCP wrappers" wording is the TASK-012 approval model, which
  does not exist. Until the purpose-built wrappers land (TASK-013), `developer` therefore
  has no route to the downstream server at all. See ADR-0005.

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
scripts/verify.ps1                  VERIFY_OK (5 steps, 9s)
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

Note: now that there is no default allowed root, a `start-local` run needs
`REMOTE_AGENT_ALLOWED_ROOTS` set (in `.env` or the environment) before the gateway will
start. That is intended, and asserted by `test:exposure`.

## Pre-merge review fixes (2026-09-18)

A review of `feat/remote-agent-v03` before merging to `main` raised five points. All five
are fixed; each has a test. See ADR-0005.

| Point | Fix | Asserted by |
|---|---|---|
| Machine-specific defaults: `DEFAULT_ROOTS = ["F:\\Project_Git"]` in `src/config.ts`, and `D:\Tools\...` / `D:\Program Files\MATLAB\R2024b` in `.env.example` | `REMOTE_AGENT_ALLOWED_ROOTS` is required — unset aborts startup exactly like empty; `.env.example` carries no path; the MATLAB downstream is opt-in with no default command/args/root; downstream `WINDIR` is inherited instead of assumed; test fixtures derive their root from the repository location | `test:policy` (unset roots refused), `test:exposure` (unset roots exit non-zero) |
| `mcp_call_tool` (generic proxy) sat at `developer` | moved to `full`, next to `shell_run`; `mcp_status` / `mcp_list_tools` stay at `developer` | `test:policy` (matrix), `test:exposure` (`developer` list no longer contains it) |
| Successful responses leaked resolved absolute paths | `fs_write` returns bytes and the handler echoes the caller's own `path`; `shell_run` no longer echoes the working directory (the caller's `cwd` is echoed only if it supplied one); `mcp_status.lastError` and downstream error text carry a short category instead of the raw spawn error (real message kept on stderr) | `test:exposure` (relative write echoes the input; no default cwd disclosure; downstream status/error free of the command path) |
| `PROJECT_STATUS.md` claimed the branch had never been pushed | this file now records the pushed branch, and the workspace section no longer claims a default root | review of this document |
| Version drift: `0.2.0` in `package.json` / `config.ts` / client, `0.1.0` in mock and test client, documents saying V0.3 | single `src/version.ts` (`0.3.0`) used by the server identity, the downstream client and the mock; `package.json` aligned | `test:policy` (package.json matches `src/version.ts`) |

### Follow-up from the code-level re-review (same day)

The reviewer checked the pushed revision on the remote (ahead 9 / behind 0 against
`main`) rather than this file's summary, and found one merge blocker plus two
non-blocking points.

Fixed:

- **`REMOTE_AGENT_DEFAULT_CWD` contradicted the documentation.** `.env.example` ships the
  line blank, and both it and the README present "copy the example, fill in the allowed
  root" as the install path, but the implementation refused a blank value as "set but
  empty" — only `undefined` fell back — so the documented install path did not start.
  Unset, empty and whitespace-only now all mean the first allowed root. A separators-only
  value (`;`) is still refused as a typo, and a value outside the roots still aborts
  startup. This does not widen access: the root list is explicit and required, so the
  fallback is one of the roots the operator just stated, not a machine default. Verified
  end to end by building the documented `.env` (`cp .env.example .env`, one root filled
  in, cwd line left blank) and starting the configuration from it:
  `roots=["F:\\Project_Git"]`, `cwd=F:\\Project_Git`. The temporary `.env` was removed
  afterwards; it is gitignored and untracked.

Recorded, not fixed here — both are unreachable from `discovery`, and both stay with
TASK-013:

- `src/downstream/matlab.ts` reads `process.env.MATLAB_MCP_*` directly instead of the
  `readOwnEnv()` helper introduced for prototype-pollution safety; unify when TASK-013
  touches that file.
- `mcp_list_tools` is declared `risk: "read"` but starts a local downstream process.

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
- `mcp_call_tool` at `full` reaches downstream MCP capability, i.e. MATLAB code
  evaluation, without any approval step. It is no longer reachable from `developer`,
  which removes the ordinary case; the TASK-013 wrappers are the narrower path.
- Path hardening cannot see hard links (reproduced as a read of `.env` and a private key
  through a pre-existing hard link), and a TOCTOU window remains between the path check and
  the file operation.
- The agent can no longer write its own manifests or dependencies (`package.json`,
  `tsconfig.json`, `package-lock.json`, `node_modules/**`, `dist/**`) — that is deliberate,
  since writing them is equivalent to executing code; it needs a local action or the
  TASK-012 approval path.
- Response hygiene is a closed list, not a guarantee: file contents and downstream tool
  output are still passed through verbatim.
- No structured audit log yet.

## Workspace

Working tree: `F:\Project_Git\P05_Remote_Agent`
There is no default allowed root. `REMOTE_AGENT_ALLOWED_ROOTS` must be set for this
machine (in `.env` or the environment) or the server refuses to start; on this machine it
points at `F:\Project_Git`. The legacy `D:` path is not used by this project.

## Open items for the user

- `feat/remote-agent-v03` is pushed to `origin`. WSL git has no credential helper and no
  `gh` CLI, but the Windows git (`D:\Program Files\Git\cmd\git.exe`, GCM installed) pushes
  from WSL without a manual login: `GIT_TERMINAL_PROMPT=1 "<windows git>" -C
  "F:\Project_Git\P05_Remote_Agent" push -u origin <branch>`. Note that a first anonymous
  `ls-remote` succeeding proves nothing about credentials (the repository is public).
- A node process started 2026-09-18 19:48 is still listening on 127.0.0.1:8765 (a
  gateway from the earlier V0.3-B verification). `start-local.ps1` now refuses that port
  until it is stopped, and probes must use a free port.
- `docs/roadmap/` and `docs/deployment/` plan documents arrived on `main` during
  TASK-001 (commits `7d05c6c`, `fafac2a`); this branch is rebased onto them.
- The repository is **public**, and the governing plan document it carries contains the
  machine's hostname and device id. Both are identifiers rather than credentials, but the
  visibility should be a deliberate choice before any real secret or internal path is
  added.
