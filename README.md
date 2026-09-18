# P05 Remote Agent

A lightweight local-first MCP gateway and Windows execution agent for exposing controlled local capabilities to remote AI clients.

## Project goal

P05 Remote Agent provides one stable MCP entry point for:
- local filesystem / shell / Git capabilities;
- downstream local MCP servers such as MathWorks MATLAB MCP;
- future remote access through Streamable HTTP;
- centralized policy, audit, approval and tool routing.

The project intentionally avoids becoming a full enterprise MCP platform. It borrows proven patterns from existing open-source gateways while keeping the runtime small enough for a single Windows engineering workstation.

## Current status: V0.3 — TASK-001 tool profile safety

Governing plan: [docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md](docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md) (Chinese) and
[docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md](docs/roadmap/REMOTE_AGENT_EXECUTION_PLAN.md) (English).

Implemented:
- MCP server over stdio;
- controlled `fs_read`, `fs_write`, `fs_list`, `shell_run`;
- downstream MCP Client abstraction;
- downstream registry;
- MATLAB MCP configuration adapter;
- generic `mcp_status`, `mcp_list_tools`, `mcp_call_tool`;
- mock downstream MCP and smoke test;
- **tool profile layer** (`P05_TOOL_PROFILE`): four profiles, tools registered only
  when the active profile allows them, unknown value aborts startup;
- **protected-path policy**: `.git`, `.p05`, credentials and `.env` are refused even
  inside an allowed root;
- **path resolution hardening**: UNC / `\\?\` / drive-relative / alternate-data-stream
  spellings refused, trailing dots and spaces canonicalised, and the resolved real path
  re-checked so a symlink or junction inside a root cannot escape it.

Next (per the plan; stop after each task):
- TASK-002 local startup standardization, TASK-003 Secure Tunnel integration;
- TASK-004 read-only file tools (`fs_search`) and TASK-005 Git tool layer, which
  complete the `readonly` profile;
- TASK-006/007 process manager and batch execution for the `developer` profile;
- TASK-010 audit log, TASK-012 approval model.

## Tool exposure

Tools are registered conditionally, not filtered at call time: a tool outside the
active profile is never advertised, so a remote client cannot discover it through
`tools/list`.

| `P05_TOOL_PROFILE` | Tool list |
|---|---|
| *(unset)* / `discovery` | `device_info`, `ping` |
| `readonly` | discovery + `fs_read`, `fs_list` |
| `developer` | readonly + `fs_write`, `mcp_status`, `mcp_list_tools`, `mcp_call_tool` |
| `full` | developer + `shell_run` |

`discovery` is the default and `full` must never be the default. An unknown
`P05_TOOL_PROFILE` aborts startup instead of falling back — see
[tool exposure policy](docs/architecture/TOOL-PROFILES.md) and
[ADR-0003](docs/adr/ADR-0003-tool-profile-policy.md).

The plan assigns more tools to these profiles than exist today (`fs_search`, `git_*`,
`apply_patch`, `process_*`, `batch_execute`). They are recorded in
`PLANNED_TOOLS` and are exposed only once implemented — see TASK-004 onwards.

`shell_run` is **not** a sandbox — it constrains the working directory, not the
command. It stays in `full` and must stay hidden from any remotely reachable daemon
until the audit log and approval model (TASK-010/TASK-012) exist.

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

## Development

Requires Node.js 22+ (validated on Node 22.23.1).

```powershell
npm install
npm run verify           # check + build + smoke:downstream + test
npm run test             # profile tests + downstream smoke
npm run test:policy      # profile matrix, path guards, command guards (no transport)
npm run test:exposure    # spawns the server per profile, asserts tools/list
npm start
```

Copy `.env.example` to `.env` and configure downstream MCP servers as needed. The
example ships with `P05_TOOL_PROFILE=discovery`.

## Repository policy

This repository is the canonical source for project code, design notes, configuration examples, tests and architecture decisions. Generated `dist/`, `node_modules/`, local secrets and logs are not committed.
