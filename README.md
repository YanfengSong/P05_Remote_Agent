# P05 Remote Agent

A lightweight local-first MCP gateway and Windows execution agent for exposing controlled local capabilities to remote AI clients.

## Project goal

P05 Remote Agent provides one stable MCP entry point for:
- local filesystem / shell / Git capabilities;
- downstream local MCP servers such as MathWorks MATLAB MCP;
- future remote access through Streamable HTTP;
- centralized policy, audit, approval and tool routing.

The project intentionally avoids becoming a full enterprise MCP platform. It borrows proven patterns from existing open-source gateways while keeping the runtime small enough for a single Windows engineering workstation.

## Current status: V0.2 framework

Implemented:
- MCP server over stdio;
- controlled `fs_read`, `fs_write`, `fs_list`, `shell_run`;
- downstream MCP Client abstraction;
- downstream registry;
- MATLAB MCP configuration adapter;
- generic `mcp_status`, `mcp_list_tools`, `mcp_call_tool`;
- mock downstream MCP and smoke test.

Next:
- install/configure MathWorks MATLAB MCP and run an end-to-end test;
- add Streamable HTTP ingress;
- add authentication;
- add Git-specific and batched execution tools;
- strengthen process sandbox / approval policy.

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
- [ADR-0001](docs/adr/ADR-0001-gateway-architecture.md)

## Development

Requires Node.js 24+.

```powershell
npm install
npm run build
npm run smoke:downstream
npm start
```

Copy `.env.example` to `.env` and configure downstream MCP servers as needed.

## Repository policy

This repository is the canonical source for project code, design notes, configuration examples, tests and architecture decisions. Generated `dist/`, `node_modules/`, local secrets and logs are not committed.
