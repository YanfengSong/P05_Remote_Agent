# P05 Remote Agent

A lightweight local-first MCP gateway and Windows execution agent for exposing controlled local capabilities to remote AI clients.

## Project goal

P05 Remote Agent provides one stable MCP entry point for:
- local filesystem / shell / Git capabilities;
- downstream local MCP servers such as MathWorks MATLAB MCP;
- future remote access through Streamable HTTP;
- centralized policy, audit, approval and tool routing.

The project intentionally avoids becoming a full enterprise MCP platform. It borrows proven patterns from existing open-source gateways while keeping the runtime small enough for a single Windows engineering workstation.

## Current status: 0.3.1 — TASK-001 tool profile safety, TASK-002 local startup, pre-merge review fixes, temporary read-only layer

Governing plan: [docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md](docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md) (Chinese) and
[docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md](docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md) (English).

Implemented:
- MCP server over stdio;
- controlled `fs_read`, `fs_write`, `fs_list`, `shell_run`;
- downstream MCP Client abstraction;
- downstream registry;
- MATLAB MCP configuration adapter (opt-in, no default path);
- generic `mcp_status`, `mcp_list_tools`, `mcp_call_tool`;
- mock downstream MCP and smoke test;
- **tool profile layer** (`P05_TOOL_PROFILE`): four profiles, tools registered only
  when the active profile allows them, unknown value aborts startup;
- **protected-path policy**: `.git`, `.p05`, credentials and `.env` are refused even
  inside an allowed root;
- **path resolution hardening**: UNC / `\\?\` / drive-relative / alternate-data-stream
  spellings refused, trailing dots and spaces canonicalised, and the resolved real path
  re-checked so a symlink or junction inside a root cannot escape it;
- **no machine-specific defaults**: there is no built-in allowed root (an unset
  `REMOTE_AGENT_ALLOWED_ROOTS` aborts startup), and the MATLAB downstream is opt-in with
  no default command, args or MATLAB root, so the repository is portable and
  `.env.example` is publishable;
- **response hygiene**: no successful response carries a resolved absolute path —
  `fs_write` echoes the caller's own path, `shell_run` never echoes the default working
  directory, and downstream failures are reported as short categories rather than raw
  spawn errors;
- **unified local startup**: `scripts/start-local.ps1` checks the toolchain, builds,
  resolves the profile, refuses a busy port and prints the device/profile/MCP/health
  banner before starting the gateway;
- **verification pipeline**: `npm run verify` plus `scripts/verify.ps1`.
- **temporary read-only layer** (`P05_TEMP_READONLY_ROOT`, TMP-R01..TMP-R06, see
  [docs/adr/ADR-0006](docs/adr/ADR-0006-temporary-readonly-capability.md)): two extra read-only
  tools, `list_directory` and `read_file`, offered only while that variable names a directory
  inside `REMOTE_AGENT_ALLOWED_ROOTS`. The variable is an opt-in *gate* checked before the profile
  rank, so an install that does not set it still exposes exactly `device_info` + `ping`. The tools
  can only ever narrow what is reachable: every path passes the existing hardened guard first and
  is then re-checked against the temporary root (real path included), credential-shaped files are
  refused, reads are capped at 1 MB, and no write, delete, move or execute path exists in that
  module. It is a stop-gap for remote document review, not the permission model — ADR-0006 records
  how it is deleted once the Security Broker lands.

Next (per the plan; stop after each task):
- TASK-003 Secure Tunnel integration (`scripts/tunnel/*`);
- TASK-004 read-only file tools (`fs_search`) and TASK-005 Git tool layer, which
  complete the `readonly` profile;
- TASK-006/007 process manager and batch execution for the `developer` profile;
- TASK-013 purpose-built downstream wrappers, which are what gives `developer` a
  narrower route to MATLAB than the generic proxy;
- TASK-010 audit log, TASK-012 approval model.

## Tool exposure

Tools are registered conditionally, not filtered at call time: a tool outside the
active profile is never advertised, so a remote client cannot discover it through
`tools/list`.

| `P05_TOOL_PROFILE` | Tool list |
|---|---|
| *(unset)* / `discovery` | `device_info`, `ping` |
| `readonly` | discovery + `fs_read`, `fs_list` |
| `developer` | readonly + `fs_write`, `mcp_status`, `mcp_list_tools` |
| `full` | developer + `mcp_call_tool`, `shell_run` |

`discovery` is the default and `full` must never be the default. An unknown
`P05_TOOL_PROFILE` aborts startup instead of falling back — see
[tool exposure policy](docs/architecture/TOOL-PROFILES.md),
[ADR-0003](docs/adr/ADR-0003-tool-profile-policy.md) and
[ADR-0005](docs/adr/ADR-0005-machine-neutral-config-and-response-hygiene.md).

The plan assigns more tools to these profiles than exist today (`fs_search`, `git_*`,
`apply_patch`, `process_*`, `batch_execute`). They are recorded in
`PLANNED_TOOLS` and are exposed only once implemented — see TASK-004 onwards.

`shell_run` and `mcp_call_tool` are **not** constrained capabilities: the first runs an
unconfined command (it constrains the working directory, not the command), the second
pipes straight through to whatever a downstream server implements, which for MATLAB
includes code evaluation. Both stay in `full` and must stay hidden from any remotely
reachable daemon until the audit log and approval model (TASK-010/TASK-012) exist.

## Architecture

```text
Remote AI Client
      |
      | Streamable HTTP (planned)
      v
P05 Remote Agent
  |-- Local Tool Layer
  |     |-- Filesystem
  |     |-- PowerShell
  |     `-- Git (planned)
  |
  `-- Downstream MCP Registry
        |-- MATLAB MCP
        |-- Playwright MCP (future)
        `-- other stdio / HTTP MCP servers
```

See:
- [Execution plan (governing)](docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md)
- [Execution plan — English](docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md)
- [Gateway comparison](docs/research/mcp-gateway-benchmark.md)
- [Target architecture](docs/architecture/ARCHITECTURE.md)
- [Tool exposure policy](docs/architecture/TOOL-PROFILES.md)
- [ADR-0001](docs/adr/ADR-0001-gateway-architecture.md)
- [ADR-0002](docs/adr/ADR-0002-repository-source-of-truth.md)
- [ADR-0003](docs/adr/ADR-0003-tool-profile-policy.md)
- [ADR-0004](docs/adr/ADR-0004-path-policy-fails-closed.md)
- [ADR-0005](docs/adr/ADR-0005-machine-neutral-config-and-response-hygiene.md)

## Development

Requires Node.js 22+ (validated on Node 22.23.1).

```powershell
npm install
npm run verify           # check + build + smoke:downstream + test
npm run test             # profile tests + downstream smoke
npm run test:policy      # profile matrix, path guards, command guards (no transport)
npm run test:exposure    # spawns the server per profile, asserts tools/list
npm start                # stdio server
```

Copy `.env.example` to `.env` and fill in the allowed root(s) for this machine — that is
the only value you must supply. There is no default root: an unset value aborts startup,
and so does an explicitly empty one. `REMOTE_AGENT_DEFAULT_CWD` may stay blank, in which
case the working directory is the first allowed root.

### Local startup

```powershell
npm run start:local                      # banner + Streamable HTTP gateway on 127.0.0.1:8765
npm run start:local -- -Profile readonly # override the profile for this run
npm run start:local -- -Port 8766        # different port
npm run start:local -- -Probe            # start, wait for /healthz, report, stop
npm run verify:win                       # scripts/verify.ps1 summary
npm run start:http                       # the underlying gateway command, unchanged
```

`start-local.ps1` refuses to start when the port is already in use, because a health
probe answered by a pre-existing listener would otherwise report success for a start
that never happened.

## Repository policy

This repository is the canonical source for project code, design notes, configuration examples, tests and architecture decisions. Generated `dist/`, `node_modules/`, local secrets and logs are not committed.
