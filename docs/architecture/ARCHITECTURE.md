# P05 Remote Agent Architecture

## Scope

P05 is a local-first MCP Gateway + Windows Agent. It exposes controlled local tools and proxies downstream MCP servers through one stable endpoint.

## Logical architecture

```text
                    Remote MCP Client
                           |
                  Streamable HTTP / HTTPS
                           |
                  +------------------+
                  |   Ingress/Auth   |
                  +------------------+
                           |
                  +------------------+
                  |  Gateway Router  |
                  +------------------+
                    /              \
                   /                \
      +--------------------+   +----------------------+
      | Local Tool Layer   |   | Downstream Registry  |
      | files/shell/git    |   | MCP Client adapters  |
      +--------------------+   +----------------------+
              |                       |
           Windows             MATLAB MCP / others
```

## Components

### Ingress
V0.2 uses stdio for local validation. V0.3 adds Streamable HTTP. External TLS/tunneling should remain separable from tool execution.

### Gateway router
Owns tool naming, dispatch, result projection and future batching. Downstream servers are addressed by stable logical IDs rather than executable paths.

### Local tool layer
Provides capabilities that need P05-specific policy: filesystem, PowerShell, Git, process management and later batched tasks.

### Downstream registry
Manages MCP Server definitions, lifecycle, connection state, tool discovery and proxy calls. MATLAB is the first downstream server.

### Policy and audit
Every high-risk operation must eventually pass through policy before execution. Required concepts: allowed roots, command policy, timeout/output limits, optional approval, and structured audit records.

## Configuration model

Runtime configuration must separate:
- gateway settings;
- local-tool policy;
- downstream MCP definitions;
- credentials/secrets.

Secrets belong in environment variables or a future secure local store, never committed to Git.

## Tool exposure strategy

V0.2 exposes generic gateway tools:
- `mcp_status`
- `mcp_list_tools`
- `mcp_call_tool`

Later versions may expose curated high-level tools such as `matlab_evaluate`, `simulink_build` and `git_status`. Curated tools reduce client-side round trips and let P05 apply domain-specific safety and output shaping.

## Non-goals for V1

- Kubernetes orchestration;
- multi-tenant enterprise RBAC;
- semantic/vector tool routing;
- external marketplace;
- database-backed control plane;
- full web administration UI.

These can be revisited only after the local workstation workflow is proven.
