# P05 Remote Agent — Tool Exposure Policy

Status: implemented (TASK-001 of the execution plan)
Source of truth: `src/policy/tool-profile.ts`

## Why this exists

Before remote access, a remote client must not be able to discover dangerous tools at
all. V0.2 registered every tool unconditionally, so the moment an ingress existed —
Streamable HTTP, or an OpenAI Secure MCP Tunnel — `tools/list` would have handed a
remote model `shell_run` and the generic downstream proxy (`mcp_call_tool`), which
reaches MATLAB code evaluation.

`shell_run` is not a sandbox: it constrains the working directory, not the command, so
`Get-ChildItem C:\`, `Get-ItemProperty HKLM:\...`, `net use \\host\share` and
`Invoke-WebRequest` are all reachable once it is exposed. The command blocklist in
`src/security.ts` is a speed bump, not a boundary (plan rule 3.5).

## The rule

A profile decides the visible tool set. Nothing else does.

1. Every exposable tool is declared in `TOOL_SPECS` with a minimum profile and a risk.
   A tool that is not declared cannot be exposed — `assertToolDeclared` throws rather
   than guessing.
2. `src/policy/expose.ts` registers a tool only when the active profile allows it. A
   suppressed tool is **never registered**, so it does not appear in `tools/list` and
   cannot be discovered. The handler re-checks the profile at call time as well.
3. An unrecognised `P05_TOOL_PROFILE` value aborts startup with a non-zero exit code.
   There is no silent fallback to a permissive default (plan rule 3.4, fail closed).
4. `discovery` is the default; `full` must never be the default.

## Profiles

Cumulative: each profile contains everything below it.

| `P05_TOOL_PROFILE` | Exposed today | Risk mix |
|---|---|---|
| *(unset)* / `discovery` | `device_info`, `ping` | read |
| `readonly` | + `fs_read`, `fs_list` | read |
| `developer` | + `fs_write`, `mcp_status`, `mcp_list_tools` | write, read |
| `full` | + `mcp_call_tool`, `shell_run` | execute |

One capability is additional to this table and is gated rather than profiled: the **temporary
read-only layer** (`list_directory`, `read_file`, ADR-0006). Those two tools are declared at
`discovery` but a capability gate — evaluated before the profile rank — hides them unless
`P05_TEMP_READONLY_ROOT` names a directory inside `REMOTE_AGENT_ALLOWED_ROOTS`. With that variable
unset the surface is exactly the `discovery` row above, so the TASK-001 DoD is unchanged by
default; with it set, the two tools appear without any profile change and can only ever reach
inside that (narrower) root. Both are read-only: no write, delete, move or execute path exists in
that module.

`mcp_call_tool` is the generic downstream proxy: through it, the entire surface of a
configured downstream server becomes reachable, and for MATLAB that surface includes
arbitrary code evaluation. Plan section 3 lists it under 禁止一开始暴露 ("never expose
initially") together with `shell_run`, so it sits at `full`. The narrower, purpose-built
downstream wrappers that the plan puts in `developer` are a TASK-013 deliverable; until
they exist, `developer` deliberately has no way to reach the downstream server.

The plan assigns more tools to these profiles than exist today. They are recorded in
`PLANNED_TOOLS` and become exposable only when implemented, so the profile decision is
not re-litigated later:

| Profile | Planned (not implemented) |
|---|---|
| `readonly` | `fs_search`, `git_status`, `git_diff`, `git_log` |
| `developer` | `apply_patch`, `process_start`, `process_wait`, `process_output`, `process_stop`, approved Git mutations, `batch_execute` |

Consequence: the `readonly` profile is only complete after TASK-004 and TASK-005. Until
then it exposes the read-only tools that exist.

## Machine-neutral configuration

Nothing in the code or in `.env.example` names a machine-specific path, and there is no
default allowed root.

- `REMOTE_AGENT_ALLOWED_ROOTS` is **required**. An unset value aborts startup with a
  non-zero exit code, exactly like a set-but-empty one. A built-in root would name one
  developer's drive and then either refuse everything or free a directory nobody chose
  on every other machine; rules 3.4 (fail closed) and section 8.1 require the operator to
  state the roots.
- The MATLAB downstream is **opt-in** (`MATLAB_MCP_ENABLED=false` by default) and has no
  default command, args or MATLAB root: those paths differ per installation. A machine
  without MATLAB reports `enabled: false` in `mcp_status` instead of failing.
- The downstream child's `WINDIR` is inherited from the environment rather than assumed
  to be `C:\Windows`.
- Test fixtures derive the allowed root from the repository's own location instead of a
  hardcoded drive, so the suite is runnable from any checkout.

See ADR-0005.

## Response hygiene

Everything a tool returns to a remote client is treated as publishable, so no successful
response may carry a resolved absolute path:

| Tool | What changed |
|---|---|
| `fs_write` | returns the byte count; the caller's own `path` argument is echoed back, never the resolved path. A relative path resolves against the server's working directory, so the old response disclosed that directory. |
| `shell_run` | returns stdout/stderr only. The resolved working directory is not echoed — when the caller omits `cwd` it is the configured default, a machine path. The caller's own `cwd` is echoed when it supplied one. |
| `mcp_status` | `lastError` is a short category (`command not found`, `access denied`, `timed out`, …). The raw spawn error contains the absolute command path. |
| `mcp_list_tools`, `mcp_call_tool` | the same category replaces a raw connect failure in the error text; the operator still gets the real message on stderr. |
| `fs_read`, `fs_list`, `device_info`, `ping` | already carried no path. |

Refusal messages follow the same rule (below). This is a closed-list rule, not a
guarantee about content: file *contents* and downstream tool *output* are passed through
verbatim, so a file or a MATLAB result can still contain paths. That is inherent to the
operation and is why `mcp_call_tool` sits at `full`.

## Protected paths

`src/security.ts` refuses paths that stay off-limits even inside an allowed root:

- **code-execution vectors** — any `.git` path segment (`fs_write` to
  `.git/hooks/pre-commit` would otherwise run arbitrary code on the next git
  operation; `.git/config` can redirect hooks), `.npmrc`, `.p05` agent state,
  `.ssh`, `.aws`;
- **secrets** — `.env`, `.env.*` (except the `.env.example` / `.env.sample` /
  `.env.template` templates), `.git-credentials`, `.netrc`, `id_rsa*`,
  `id_ed25519*`, `id_ecdsa`, `credentials`, and `*.pem` / `*.pfx` / `*.p12`.

Read and write share the protected-name list; a write-side approval step (TASK-012) would be
a divergence inside `assertAccessiblePath`.

### Write-side code-execution paths

A write is additionally refused inside directories and to files that turn a text write into
code that runs later with no further tool call:

| Refused for write | Why |
|---|---|
| any `node_modules` / `dist` segment | code this agent itself loads |
| any `.vscode` segment | tasks and settings the editor executes |
| `package.json`, `package-lock.json` | scripts run on the next install |
| `tsconfig.json`, `.mcp.json`, `.gitmodules` | build and tooling configuration |

Reads stay allowed — a build artefact holds no secret, and blocking reads would break
ordinary work. The consequence is deliberate: the agent cannot update its own manifests
remotely; that is a local action today and an approval case (TASK-012) later.

## Path resolution

A path policy that only compares strings is bypassable, because several spellings
change which file the OS actually touches while still looking local. Every `fs_*` path
passes four checks, in order:

1. **shape** — UNC and `\\?\` extended-length paths, drive-relative forms (`F:foo`)
   and alternate data streams (`name:stream`) are refused outright: the policy cannot
   reason about them, so it declines them instead of guessing.
2. **allowed root** — the resolved path must sit inside a configured root.
3. **protected names** — matched after trimming trailing dots and spaces, because
   Windows strips those, so `.git.` and `.git ` name the same directory as `.git`.
4. **real path** — the path is re-resolved through symlinks, NTFS junctions and 8.3
   short names (walking up to the nearest existing ancestor for a file that does not
   exist yet). The first component that exists **must** canonicalise: a junction whose
   target does not exist is refused rather than falling back to the unresolved path,
   because that fallback would make the real path equal the requested path and silently
   skip this whole check. If the real path differs from the requested one, it must
   *also* be inside the allowed roots and *also* be free of protected names.

Step 4 closes two escape classes that were reproduced against an earlier revision: a
symlink or junction that already exists inside an allowed root (`node_modules/.bin`-style
links are ordinary) pointing outside it, and a dangling junction whose check used to pass
and whose write landed outside the roots once the target appeared. See ADR-0004.

Refusal messages are returned to the remote, so they echo only the caller's own input and
the rule that refused it — never the resolved path, the process working directory or a link
target, all of which would let a remote client enumerate the machine for free.

Residual risk, accepted and documented rather than papered over:

- **hard links** — `realpath` cannot see them. A pre-existing hard link inside a root
  pointing at another file on the same volume is not detected; a reviewer reproduced one
  reading a `.env` and a private key. Refusing every multi-linked file was rejected because
  legitimate toolchains (pnpm stores) rely on them;
- **TOCTOU** — a small window exists between this check and the caller's open();
- 8.3 short names are not generated on the volumes in use here, so that spelling is not
  reachable in practice (the probe reports a skip rather than a pass).

## Operating it

```powershell
# required first: state the roots this agent may touch (there is no default)
#   .env:  REMOTE_AGENT_ALLOWED_ROOTS=<absolute path>[;<absolute path>]

# default read-only discovery surface
npm start

# read-only working surface
#   .env:  P05_TOOL_PROFILE=readonly

# development surface (file writes, downstream MCP read/list)
#   .env:  P05_TOOL_PROFILE=developer

# highest surface: adds shell_run and the generic downstream proxy
#   .env:  P05_TOOL_PROFILE=full

# temporary read-only layer (ADR-0006): two extra read tools, opt-in per machine
#   -- leave it out and the surface is unchanged (device_info + ping at discovery)
#   -- the value must be inside REMOTE_AGENT_ALLOWED_ROOTS; it can only narrow that area
#   -- a relative value, or one outside the allowed roots, aborts startup
#   .env:  P05_TEMP_READONLY_ROOT=<absolute directory inside an allowed root>
```

Every server start writes one line to **stderr** (stdout is the JSON-RPC channel):

```json
{"event":"p05.tool_profile","profile":"discovery","profileSource":"default",
 "exposed":["device_info","ping"],
 "suppressed":[{"tool":"fs_read","reason":"requires profile \"readonly\" or higher (active: \"discovery\")"}]}
```

## Verifying

```powershell
npm run verify            # check + build + smoke:downstream + test
npm run test:policy       # profile matrix, path guards, command guards (no transport)
npm run test:exposure     # spawns the real server per profile and asserts tools/list
```

`test:exposure` asserts the TASK-001 DoD verbatim (`P05_TOOL_PROFILE=discovery` returns
exactly `device_info` + `ping`, and `shell_run` / `fs_write` / `mcp_call_tool` are
absent), the exact tool list for every profile, that the stderr report agrees with
`tools/list`, that every suppressed tool is genuinely uncallable, that device identity
is stable across restarts, and that `shell_run` really executes at `full`.

It then builds real escape attempts on disk and asserts each is refused, and that
nothing was written where it should not be:

- a junction inside the allowed root pointing outside it — read and write refused, and
  no file planted in the target;
- a junction inside the allowed root pointing at `.git` — write refused;
- a **dangling** junction (target does not exist) — read and write refused, so a check
  can never pass and the write land outside later;
- `.git.` (trailing dot) and plain `.git` — refused, and no `pre-commit` appears;
- an alternate data stream (`probe.txt:evil`) — refused;
- a `\\?\` extended-length path — refused;
- a write to `node_modules`, `dist`, `package.json`, `tsconfig.json` or `.vscode/tasks.json`
  — refused, with `package.json` byte-identical afterwards;
- `shell_run` with a junction as `cwd` — refused, and nothing written at the target;
- an 8.3 short name for `.git`, when the volume generates one (this volume does not,
  so the probe reports a skip rather than a pass);
- refusals must not contain the link target, the working directory or the allowed root.

Response hygiene and configuration are asserted too:

- a relative `fs_write` echoes the caller's own path and not the resolved one;
- `shell_run` without `cwd` does not disclose the default working directory;
- `mcp_status` and a downstream connect failure stay free of the configured command path;
- an unset `REMOTE_AGENT_ALLOWED_ROOTS` exits non-zero, as does an empty one;
- `package.json` and `src/version.ts` carry the same version.

## What this policy does NOT do

- It does not sandbox `shell_run`. Once `full` is active, a command can read other
  drives, the registry and network shares. There is still only the small destructive
  command blocklist, and TASK-009 is where command policy is properly reworked.
- It does not constrain the downstream proxy's capability surface: `mcp_call_tool`
  grants whatever the downstream server can do, which is why it sits at `full`.
  TASK-012 (approval model) and TASK-013 (purpose-built wrappers) own the narrower path.
- It does not sanitise file contents or downstream output — those are passed through
  verbatim by design (see Response hygiene).
- It has no approval prompt and no structured audit log yet (TASK-010/TASK-012).
- Path hardening cannot see hard links, and a TOCTOU window remains.
- `P05_TOOL_PROFILE` is unrelated to `tunnel-client`'s own "profile" concept, which
  names a tunnel-client configuration file. Do not conflate the two.
