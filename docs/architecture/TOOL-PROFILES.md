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
| `developer` | + `fs_write`, `mcp_status`, `mcp_list_tools`, `mcp_call_tool` | write, execute |
| `full` | + `shell_run` | execute |

The plan assigns more tools to these profiles than exist today. They are recorded in
`PLANNED_TOOLS` and become exposable only when implemented, so the profile decision is
not re-litigated later:

| Profile | Planned (not implemented) |
|---|---|
| `readonly` | `fs_search`, `git_status`, `git_diff`, `git_log` |
| `developer` | `apply_patch`, `process_start`, `process_wait`, `process_output`, `process_stop`, approved Git mutations, `batch_execute` |

Consequence: the `readonly` profile is only complete after TASK-004 and TASK-005. Until
then it exposes the read-only tools that exist.

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
# default read-only discovery surface
npm start

# read-only working surface
#   .env:  P05_TOOL_PROFILE=readonly

# development surface (file writes, downstream MCP)
#   .env:  P05_TOOL_PROFILE=developer
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

## What this policy does NOT do

- It does not sandbox `shell_run`. Once `full` is active, a command can read other
  drives, the registry and network shares. There is still only the small destructive
  command blocklist, and TASK-009 is where command policy is properly reworked.
- It does not cover the downstream proxy's own capability surface: `mcp_call_tool`
  grants whatever the downstream server can do. Its placement in `developer` follows
  the plan's "approved downstream MCP wrappers"; TASK-012 (approval model) is the
  intended gate for that wording.
- It has no approval prompt and no structured audit log yet (TASK-010/TASK-012).
- Path hardening cannot see hard links, and a TOCTOU window remains.
- `P05_TOOL_PROFILE` is unrelated to `tunnel-client`'s own "profile" concept, which
  names a tunnel-client configuration file. Do not conflate the two.
