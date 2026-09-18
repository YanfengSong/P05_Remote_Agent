# P05 Remote Agent

A lightweight local-first MCP gateway and Windows execution agent for exposing controlled local capabilities to remote AI clients.

## Project goal

P05 Remote Agent provides one stable MCP entry point for:
- local filesystem / shell / Git capabilities;
- downstream local MCP servers such as MathWorks MATLAB MCP;
- future remote access through Streamable HTTP;
- centralized policy, audit, approval and tool routing.

The project intentionally avoids becoming a full enterprise MCP platform. It borrows proven patterns from existing open-source gateways while keeping the runtime small enough for a single Windows engineering workstation.

## Current status: V0.3 phase 1 — safe tool profiles

Implemented:
- MCP server over stdio;
- controlled `fs_read`, `fs_write`, `fs_list`, `shell_run`;
- downstream MCP Client abstraction;
- downstream registry;
- MATLAB MCP configuration adapter;
- generic `mcp_status`, `mcp_list_tools`, `mcp_call_tool`;
- mock downstream MCP and smoke test;
- **tool exposure gate**: profile ceiling (`P05_TOOL_PROFILE`) plus local unlock flags,
  with suppressed tools never registered;
- **protected-path policy**: `.git`, `.p05`, credentials and `.env` are refused even
  inside an allowed root.

Next:
- install/configure MathWorks MATLAB MCP and run an end-to-end test;
- add Streamable HTTP ingress and bearer-token authentication;
- add structured audit log and an approval hook for write/execute tools;
- add Git-specific and batched execution tools;
- connect the OpenAI Secure MCP Tunnel runtime.

## Tool exposure

Tools are not all published at once. A remote client only sees what the active profile
and its local unlock flags allow, and a suppressed tool is never registered, so it
cannot be discovered through `tools/list`.

| Profile | Unlocks | Surface |
|---|---|---|
| *(unset)* / `safe` | — | `device_info`, `ping`, `policy_info`, `fs_read`, `fs_list` |
| `dev` | — | + `mcp_status`, `mcp_list_tools` |
| `dev` | `P05_ENABLE_FS_WRITE=1` | + `fs_write` |
| `full` | — | same as `dev`; escalation alone arms nothing |
| `full` | `P05_ENABLE_SHELL`, `P05_ENABLE_DOWNSTREAM_EXEC` | + `shell_run`, `mcp_call_tool` |

An unknown `P05_TOOL_PROFILE` aborts startup. See
[tool exposure policy](docs/architecture/TOOL-PROFILES.md) and
[ADR-0003](docs/adr/ADR-0003-tool-profile-policy.md).

`shell_run` is **not** a sandbox — it constrains the working directory, not the
command. Do not unlock it on a daemon that a remote client can reach until the audit
log and approval hook exist.

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
npm run build
npm test                 # policy + exposure + downstream smoke
npm run smoke:downstream # downstream MCP round trip only
npm start
```

Copy `.env.example` to `.env` and configure downstream MCP servers as needed. The
example ships with `P05_TOOL_PROFILE=safe` and no unlock flags.

## Repository policy

This repository is the canonical source for project code, design notes, configuration examples, tests and architecture decisions. Generated `dist/`, `node_modules/`, local secrets and logs are not committed.
