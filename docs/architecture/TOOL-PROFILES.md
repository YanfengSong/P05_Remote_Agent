# P05 Remote Agent — Tool Exposure Policy

Status: implemented in V0.3 phase 1 (branch `feat/remote-agent-v03`)
Scope: which MCP tools a remote client is allowed to discover and call.

## Why this exists

V0.2 registered every tool unconditionally. The moment an ingress exists — Streamable
HTTP, or an OpenAI Secure MCP Tunnel — a remote model would discover `shell_run` and
`mcp_call_tool` in `tools/list` and be able to invoke them. `shell_run` is not a
sandbox: it constrains the working directory, not the command, so a single
`Get-ChildItem C:\` or `net use \\host\share` escapes the allowed roots. The generic
downstream proxy is a second execution surface for the same reason (MATLAB evaluate).

Therefore the rule is: **no dangerous capability is reachable until it is explicitly
unlocked, and a capability that is not exposed is never registered at all.**

## The rule — two keys

A tool is exposed only when BOTH conditions hold:

1. **Profile ceiling** — the active profile (`P05_TOOL_PROFILE`) ranks at or above the
   tool's `minProfile`.
2. **Local unlock** — for every `write` or `execute` tool, its unlock flag environment
   variable is truthy (`1` / `true` / `yes` / `on`, case-insensitive).

Escalating the profile alone grants nothing dangerous. `P05_TOOL_PROFILE=full` with no
unlock flags exposes exactly the same set as `dev`.

Suppression is applied *at registration*: a suppressed tool is absent from
`tools/list`, so it cannot be discovered, described or called. Handlers additionally
re-check the gate before running (defence in depth).

An unrecognised profile value aborts startup with a non-zero exit code. There is no
silent fallback to a permissive default.

## Catalog

Declared once in `src/policy/spec.ts`. A tool that is not declared there cannot be
exposed — `expose()` throws rather than guess.

| Tool | min profile | risk | unlock flag | notes |
|---|---|---|---|---|
| `device_info` | safe | read | — | identity + runtime info |
| `ping` | safe | read | — | liveness |
| `policy_info` | safe | read | — | reports the active policy so a client can explain its own limits |
| `fs_read` | safe | read | — | allowed roots, minus protected paths |
| `fs_list` | safe | read | — | allowed roots, minus protected paths |
| `fs_write` | dev | write | `P05_ENABLE_FS_WRITE` | allowed roots, minus protected paths |
| `mcp_status` | dev | read | — | local registry state only |
| `mcp_list_tools` | dev | read | — | spawns the downstream server to enumerate its tools |
| `shell_run` | full | execute | `P05_ENABLE_SHELL` | **not a sandbox** |
| `mcp_call_tool` | full | execute | `P05_ENABLE_DOWNSTREAM_EXEC` | second execution surface |

Resulting surfaces:

| Profile | Unlocks set | Exposed tools |
|---|---|---|
| unset / `safe` | none | `device_info`, `fs_list`, `fs_read`, `ping`, `policy_info` |
| `dev` | none | the above + `mcp_list_tools`, `mcp_status` |
| `dev` | `P05_ENABLE_FS_WRITE` | the above + `fs_write` |
| `full` | none | identical to `dev` + none (escalation is not enough) |
| `full` | all three | all ten tools |

## Protected paths

`src/security.ts` refuses paths that stay off-limits even inside an allowed root:

- **code-execution vectors** — any `.git` path segment (`fs_write` to
  `.git/hooks/pre-commit` would otherwise run arbitrary code on the next git
  operation; `.git/config` can redirect hooks), `.npmrc`, `.p05` agent state,
  `.ssh`, `.aws`;
- **secrets** — `.env`, `.env.*` (except the `.env.example` / `.env.sample` /
  `.env.template` templates), `.git-credentials`, `.netrc`, `id_rsa*`,
  `id_ed25519*`, `id_ecdsa`, `credentials`, and `*.pem` / `*.pfx` / `*.p12`.

Read and write currently share one list; a write-side approval step would be a
divergence inside `assertAccessiblePath`.

## Operating it

```powershell
# read-only surface (default; also the state when .env is missing)
npm start

# add file writes, keep execution locked
#   .env:  P05_TOOL_PROFILE=dev
#          P05_ENABLE_FS_WRITE=1

# full local session (never for a tunnel-reachable daemon)
#   .env:  P05_TOOL_PROFILE=full
#          P05_ENABLE_SHELL=1
#          P05_ENABLE_DOWNSTREAM_EXEC=1
```

Every server start writes one line to **stderr** (stdout is the JSON-RPC channel):

```json
{"event":"p05.tool_profile","profile":"safe","profileSource":"default",
 "exposed":["device_info","fs_list","fs_read","ping","policy_info"],
 "suppressed":[{"tool":"fs_write","reason":"requires profile \"dev\" or higher (active: \"safe\")"}],
 "unlockFlags":[]}
```

`policy_info` returns the same picture to the client on demand.

## Verifying

```powershell
npm run test:policy     # gate, catalog invariants, protected paths (no transport)
npm run test:exposure   # spawns the real server per profile and asserts tools/list
npm test                # both + the downstream smoke test
```

`test:exposure` asserts, for every profile combination, the exact `tools/list` set,
that `policy_info` agrees, that every suppressed tool is genuinely uncallable, that
`full` without unlocks grants nothing, that an unlocked `shell_run` really executes,
and that a `.git/hooks` write is refused *and* does not create the file.

## What this policy does NOT do

- It does not sandbox `shell_run`. Once unlocked, a command can read other drives,
  the registry and network shares. `src/security.ts` still holds a small destructive
  command blocklist, but treat the unlock as full local execution.
- It does not cover the downstream proxy's own capability surface: unlocking
  `mcp_call_tool` is equivalent to unlocking whatever the downstream server can do.
- It has no approval prompt and no structured audit log yet. Both are later V0.3
  items; until they exist, keep the daemon on `safe` or `dev`.
- `P05_TOOL_PROFILE` is unrelated to `tunnel-client`'s own "profile" concept, which
  names a tunnel-client configuration file. Do not conflate the two.
