# ADR-0001: Use a lightweight hybrid MCP gateway architecture

Status: Accepted  
Date: 2026-09-18

## Context

P05 must let remote AI clients safely reach local Windows capabilities and downstream MCP servers such as MATLAB MCP. Existing projects range from narrow transport bridges to enterprise control planes.

## Decision

P05 will be a single local process that combines:
1. MCP Server role for upstream clients;
2. MCP Client role for downstream MCP servers;
3. P05-owned local tools for filesystem/shell/Git/process operations;
4. a small registry/router;
5. a later Streamable HTTP ingress and authentication layer.

The official MCP TypeScript SDK is the protocol foundation. Supergateway/mcp-proxy are references and interoperability tools, not required runtime dependencies. Full platforms such as MCPHub, One MCP, Context Forge and Microsoft MCP Gateway are reference architectures, not dependencies.

## Consequences

Positive:
- minimal runtime footprint;
- full control over local safety policy and batching;
- downstream MCP servers remain unmodified;
- one stable endpoint for ChatGPT or other MCP clients.

Trade-offs:
- P05 owns lifecycle, audit, ingress and auth code;
- some capabilities already present in larger gateways must be reimplemented selectively;
- security review is required before internet exposure.
