# P05 Target Architecture V1

Status: superseded by TARGET_ARCHITECTURE_V2.md
Date: 2026-09-20

## Goal

P05 is a remote engineering Agent platform for multiple explicitly authorized workspaces.

P05 itself is a platform-source workspace, not the parent directory that all business projects must live inside.

## Runtime model

```text
ChatGPT / MCP Client
        |
        v
+-----------------------+
|      Agent Core       |
+-----------+-----------+
            |
   +--------+---------+
   | Workspace Context |
   +--------+---------+
            |
   +--------+---------+
   | Capability/Policy |
   +--------+---------+
            |
   +--------+---------+
   | Execution Runtime |
   +----+----------+---+
        |          |
      Audit     Recovery
        |
   Local tools / downstream MCP / host broker
```

## Core contracts

### Workspace

A workspace is a logical id mapped to an operator-authorized directory.

Rules:
- workspaces are registered at startup, not invented by a remote caller;
- every root must be inside `REMOTE_AGENT_ALLOWED_ROOTS`;
- remote switching uses workspace id only, never an arbitrary path;
- host paths are not returned by workspace list/current tools;
- each MCP server session owns its current workspace context.

Implemented Base V1 tools:
- `workspace_list`
- `workspace_current`
- `workspace_switch`

Configuration:
- `P05_WORKSPACES_JSON`
- `P05_ACTIVE_WORKSPACE_ID`

If no registry is configured, one backward-compatible `default` workspace is created from the configured default cwd.

### Capability Registry

Every remote capability must have:
- stable name;
- minimum profile;
- risk;
- scope;
- summary.

Scopes:
- platform
- workspace
- downstream
- host
- temporary

Base V1 keeps `TOOL_SPECS` as the profile/risk source and adds a capability-registry adapter for scope.
A later migration may move all declaration ownership into one registry after behavior is proven.

### Execution Runtime

Tool calls pass through one runtime wrapper after policy approval.

Lifecycle in Base V1:

```text
policy check -> running -> succeeded | failed -> audit
```

Future lifecycle:

```text
prepare -> policy -> execute -> verify -> report -> recover
```

### Audit

Base V1 audit is session-local and bounded.

It stores metadata only:
- execution id;
- capability;
- scope;
- workspace id;
- state;
- timestamps/duration;
- error category;
- recovery hint.

It deliberately does not store command text, file contents or tool argument payloads.

Tool:
- `activity_recent`

### Recovery

Base V1 defines recovery hints in execution records but does not yet persist runtime state across Agent restart.

Persistent recovery is the next foundation phase. It must not be implemented by silently widening filesystem or host authority.

## Tool scope rules

Workspace-scoped:
- fs tools;
- Git inspection;
- shell.

Platform-scoped:
- device;
- workspace control;
- activity;
- P05 fixed developer verification.

Host-scoped:
- runtime restart through external broker.

Downstream-scoped:
- downstream MCP status/discovery/calls.

## Security boundary

Workspace context is an operational context, not a shell sandbox.

Structured file/Git tools use the active workspace as their relative-path/default repository context while still obeying the outer allowed-root policy.

`shell_run` defaults to the active workspace cwd but retains the paired Windows user's authority. Work outside the authorized workspace follows the explicit human-approval operating rule; hard containment requires OS isolation.

## Migration plan

1. Base V1 — Workspace / Capability / Runtime / Audit contracts. **Current**
2. Move remaining tool registration behind Capability Registry helpers.
3. Add persistent execution/recovery state.
4. Add process/session runtime.
5. Add asynchronous search.
6. Add reviewed Git mutation.
7. Add downstream MATLAB/Simulink wrappers.
8. Add richer multi-device and optional GUI capabilities.