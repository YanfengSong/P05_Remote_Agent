# MCP Gateway Benchmark

Research date: 2026-09-18

## Decision summary

P05 Remote Agent should remain a lightweight local-first MCP gateway/agent rather than adopting a full gateway platform wholesale.

We will:
- use the official MCP TypeScript SDK as the protocol foundation;
- implement one local gateway process that is both an MCP Server and an MCP Client;
- keep a small downstream MCP registry/router inside P05;
- add Streamable HTTP ingress directly to P05;
- borrow safety/UI/auth patterns from mature projects without importing their full control planes;
- keep third-party transport bridges such as Supergateway or mcp-proxy available as debugging/fallback tools, not mandatory runtime dependencies.

## Comparison

| Project | Transport | Registry / aggregation | Routing | Auth / policy | Local-agent focus | Web UI | What P05 should borrow |
|---|---|---|---|---|---|---|---|
| [aiguicai/MCP-Gateway](https://github.com/aiguicai/MCP-Gateway) | stdio -> SSE / Streamable HTTP | Yes | Per-server endpoints, skills and built-ins | Tokens, path guards, command policies, approvals | Strong | Yes | Local-machine safety model, approvals, management UX |
| [supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway) | Strong stdio/SSE/WS/Streamable HTTP conversion | No | Transport bridge | Bearer/header support | Low | No | Transport behavior and interoperability tests |
| [samanhappy/mcphub](https://github.com/samanhappy/mcphub) | stdio/SSE/Streamable HTTP | Strong | Groups, aliases, smart routing | OAuth, bearer, per-user visibility | Medium | Strong | Registry/group model, health/log concepts |
| [metatool-ai/metamcp](https://github.com/metatool-ai/metamcp) | MCP aggregation | Strong | Proxy/aggregator | Centralized config | Medium | Yes | Virtual/aggregated MCP endpoint concept |
| [dpdanpittman/mcp-supergateway-hub](https://github.com/dpdanpittman/mcp-supergateway-hub) | Based on Supergateway | Multi-server hub | Per-server exposure | Basic deployment controls | Medium | Limited | Simple multi-server launch/config pattern |
| [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) | Multi-transport gateway | Enterprise-grade | Strong gateway/federation | Enterprise auth/governance | Low | Yes | Audit/observability ideas only |
| [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | Bidirectional stdio <-> SSE/Streamable HTTP | Named servers | Transport routing | Headers/OAuth2 client credentials | Low | No | Small proxy semantics and named-server config |
| [burugo/one-mcp](https://github.com/burugo/one-mcp) | stdio/SSE/Streamable HTTP | Strong | Service groups | Multi-user/OAuth | Medium | Strong | Service grouping, usage/health UI model |
| [microsoft/mcp-gateway](https://github.com/microsoft/mcp-gateway) | Streamable HTTP data plane | Strong control plane | Dynamic tool router, session-aware routing | Entra/RBAC | Low | Yes | Separation of data plane/control plane and tool router concepts |
| [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry) | Gateway for MCP and other assets | Very strong | Dynamic discovery / virtual MCP | Fine-grained scopes, audit, egress auth | Low | Yes | Registry metadata, audit, fail-closed admission concepts |
| [atrawog/mcp-oauth-gateway](https://github.com/atrawog/mcp-oauth-gateway) | HTTP gateway around MCP | Dynamic services | Reverse proxy | OAuth 2.1, PKCE, JWT, GitHub IdP | Low | Infra-oriented | Separation of TLS/auth/routing; OAuth reference patterns |

## Build vs reuse

| Capability | P05 decision |
|---|---|
| MCP protocol implementation | **Reuse** official TypeScript MCP SDK |
| stdio downstream client | **Build thin adapter** on official SDK |
| Downstream registry | **Build** lightweight local registry |
| Tool router | **Build** deterministic router; no semantic routing in V1 |
| Streamable HTTP ingress | **Build thin transport layer** on official SDK; use Supergateway/mcp-proxy for interoperability testing |
| Public internet tunnel | **External** optional tunnel/reverse proxy; not core business logic |
| Files/shell/Git tools | **Build** because local policy and batching are central requirements |
| MATLAB integration | **Reuse** MathWorks MATLAB MCP; expose through downstream registry |
| Authentication | V1 bearer token; later OAuth 2.1 if required |
| Approval/audit | **Build** small local policy/audit layer |
| Web UI | Defer until core gateway + MATLAB + remote ingress are stable |

## Why not adopt a full gateway

MCPHub, One MCP, Context Forge and the Microsoft/agentic-community gateways solve broader multi-user/platform problems. P05 primarily targets one engineering workstation that needs controlled remote AI access to local files, Git, PowerShell, MATLAB and future MCP tools.

Importing a full platform now would add database, container, identity and operations complexity before the core local-agent problem is proven.

## V1 target

The V1 success path is:

```text
ChatGPT / MCP Client
        |
        | HTTPS + Streamable HTTP
        v
P05 Remote Agent
   |-- Auth + policy + audit
   |-- Local tool layer
   |-- Downstream MCP registry
   |      `-- MATLAB MCP
   `-- Process/session manager
```
