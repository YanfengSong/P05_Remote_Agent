# P05 V3 Core Bootstrap and Resilience Design

Status: proposed V3 architecture design
Branch: v3
Parent:
- V3_CORE_CONTRACT.md
- V3_CORE_V2_INVENTORY.md

## 1. Design objective

V3 Core is the stable local control and recovery plane.

The primary availability objective is:

> ChatGPT should keep a stable MCP connection to P05 Core even when optional runtimes, plugins, downstream MCP servers, UI, persisted optional state, or ordinary configuration are broken.

V3 therefore treats "fail closed" as **reduce authority/capability**, not "go offline", whenever the Core process and MCP transport are still technically able to run.

## 2. Stable endpoint per Core Instance

Each active P05 Core Instance/Slot exposes one stable MCP endpoint. A Host may run multiple Slots concurrently for different Workspaces.

```text
ChatGPT / AI
     |
     | MCP
     v
+-----------------------+
|       P05 Core        |
| stable MCP endpoint   |
+----------+------------+
           |
           | internal extension bridge
           v
+-----------------------+
| Optional Runtime Host |
| plugins / downstream  |
| future domain runtime |
+-----------------------+
```

Optional systems MUST NOT require an additional mandatory AI connection for the same Slot.

The Core owns the stable MCP session and fixed recovery tool surface.
Optional tools may be routed through the Core, but failure of the optional runtime returns an explicit unavailable error and cannot invalidate the Core connection.

## 3. Process boundary

### 3.1 Core process

The Core process contains only:

- MCP protocol edge;
- device identity;
- bootstrap trust state;
- recovery workspace;
- policy/approval enforcement;
- file repair primitives;
- local Git repair primitives;
- bounded diagnostics/audit;
- runtime supervision;
- break-glass shell;
- internal extension bridge client.

### 3.2 Optional Runtime Host

Plugin implementations, downstream MCP clients, MATLAB, STM32, Agent/Skill/Workflow and future domain runtimes live outside the Core process.

The first V3 migration MAY initially retain the current V2 optional runtime implementation behind an adapter, but the target fault boundary is a separate process.

Reason: catching plugin start exceptions is not enough. Import-time failure, native-library failure, event-loop blocking, memory failure or process crash must not kill the Core.

### 3.3 External process supervisor

The existing deployment/runtime launcher remains responsible for restarting the Core process if the Core itself exits.

Core supervision handles optional runtime failure.
Host supervision handles Core process failure.

These are separate responsibilities.

## 4. Bootstrap trust split

V3 separates **bootstrap trust configuration** from ordinary runtime configuration.

### 4.1 Bootstrap Trust State

Small, machine-local and changed rarely:

- device identity reference;
- P05 platform/recovery root;
- P05 state directory;
- minimum authority/policy reference;
- Core version/schema metadata.

This state exists only to let Core safely establish its recovery plane.

It MUST NOT contain plugin/domain configuration.

### 4.2 Runtime / Optional State

Examples:

- additional Workspaces;
- active workspace preference;
- plugin configuration;
- downstream MCP definitions;
- UI preferences;
- optional runtime state.

Corruption here MUST NOT make Core unavailable.

## 5. Failure semantics

V3 separates liveness, readiness and optional health.

### 5.1 Liveness

"Is the Core process and MCP endpoint responding?"

Optional systems never affect Core liveness.

### 5.2 Core readiness

"Can Core provide the minimum trusted recovery surface?"

Core readiness requires:

- MCP server operational;
- device identity available;
- bootstrap trust state valid enough to establish bounded authority;
- recovery workspace available;
- policy active;
- minimum recovery tools registered.

Optional systems never affect Core readiness.

### 5.3 Optional health

"Are extension/runtime systems available?"

Reported separately and may be partially failed.

## 6. Core modes

Core exposes one explicit mode.

### NORMAL

Core recovery plane is ready and optional runtime attached successfully.

### DEGRADED

Core recovery plane is ready, but one or more optional subsystems failed.

Examples:

- plugin runtime unavailable;
- downstream MCP invalid;
- operator UI unavailable;
- optional workspace state quarantined.

### RECOVERY

Core recovery plane is ready but ordinary runtime configuration/state is damaged or intentionally bypassed.

Optional runtime is not attached automatically.

### LOCKED

MCP stays online for diagnostics, but trusted authority cannot be established safely.

Only non-mutating minimum diagnostics are exposed:

- ping;
- device_info;
- core_status;
- bootstrap diagnostics.

No file write, Git mutation or shell execution is allowed until trust configuration is repaired by an authorized local path.

This preserves fail-closed security without unnecessarily making the host disappear.

## 7. Boot sequence

```text
Phase 0  Start process
         |
         v
Phase 1  Start minimal MCP edge
         expose: ping / device_info / core_status
         |
         v
Phase 2  Load Bootstrap Trust State
         |
         +-- invalid --> LOCKED (MCP remains online)
         |
         v
Phase 3  Establish Recovery Workspace + Policy
         register recovery tools
         |
         +-- safe failure --> RECOVERY/LOCKED
         |
         v
      CORE READY
         |
         v
Phase 4  Load non-authoritative state
         workspace history / audit / preferences
         quarantine invalid files
         |
         v
Phase 5  Attach Optional Runtime asynchronously
         |
         +-- success --> NORMAL
         +-- failure --> DEGRADED
```

The architectural boundary is **CORE READY before Phase 5**.

## 8. Core status contract

V3 should add a stable built-in status contract conceptually equivalent to:

```text
core_status
  availability: online
  ready: true|false
  mode: normal|degraded|recovery|locked
  version
  startedAt
  recoveryWorkspace
  policyState
  optionalRuntime:
    state: attached|failed|disabled|starting
    lastErrorCategory?
  quarantinedState[]
```

The exact public schema can be finalized during implementation.

`ping` remains trivial and should not recursively inspect optional systems.

## 9. Optional subsystem supervision

Core sees optional functionality through a generic supervision boundary, not plugin implementation types.

Conceptual contract:

```text
OptionalRuntimeSupervisor
  status()
  start()
  stop()
  restart()
  disable()
  diagnostics()
```

The Core MUST be able to report "optional runtime offline" even when the optional runtime cannot answer.

Plugin-specific lifecycle and plugin API remain outside this V3 Core design.

## 10. Tool routing

### 10.1 Fixed Core tools

Core recovery tools are registered directly and never depend on the optional runtime.

### 10.2 Optional tools

Optional/domain tool calls go through an internal bridge.

If the runtime is unavailable:

- Core remains online;
- the request fails with a structured optional-runtime-unavailable error;
- the failure is recorded;
- Core tools remain callable.

No optional tool handler executes in the Core process in the target design.

## 11. State corruption handling

Non-authoritative persisted state uses quarantine instead of fatal startup.

Pattern:

1. detect invalid/corrupt state;
2. move or copy it to a quarantine location with timestamp/hash;
3. create a diagnostic event;
4. continue with safe defaults that do not widen authority;
5. enter DEGRADED or RECOVERY mode when appropriate.

Bootstrap trust state is different: invalid trust data causes LOCKED mode, not guessed defaults.

## 12. Core repair surface

The V3 Core repair surface remains:

- device/core status;
- workspace discovery/control;
- file list/read/write/exact patch;
- local Git status/diff/add/commit/safe branch;
- activity/recovery diagnostics;
- optional runtime status/restart/disable;
- Core/runtime restart;
- controlled break-glass shell.

Not Core:

- git push;
- arbitrary downstream MCP execution;
- MATLAB/STM32/domain tools;
- Agent/Skill/Workflow execution;
- UI logic.

## 13. Proposed source boundary

Target incremental layout:

```text
src/
  core/
    bootstrap.ts
    status.ts
    mode.ts
    trust.ts
    recovery-workspace.ts
    optional-runtime-supervisor.ts

  protocol/
    mcp.ts

  device/
  workspace/
  policy/
  audit/
  tools/
    core/

  optional/
    runtime-adapter.ts

  plugin/       # optional layer
  plugins/      # optional layer
  downstream/   # optional layer
  operator/     # optional layer
```

Physical movement should be incremental. Dependency direction matters more than immediate folder renaming.

## 14. First implementation slice

The first implementation slice should change only boot ownership.

### V3-C1 ? Core Bootstrap Separation

Deliver:

1. extract Core bootstrap from `src/index.ts`;
2. establish `CORE READY` before optional runtime attach;
3. add `core_status`;
4. make plugin/downstream attach best-effort;
5. introduce DEGRADED state;
6. add a no-plugins/no-downstream boot test.

Do NOT yet implement:

- new Plugin API;
- Agent;
- Skill;
- Workflow;
- Durable Run/Fiber;
- generic hot reload;
- multi-device.

## 15. V3-C1 acceptance

V3-C1 passes only if:

1. Core starts with the optional runtime disabled.
2. ChatGPT can call Core recovery tools.
3. Optional runtime startup failure changes mode to DEGRADED but does not disconnect MCP.
4. `ping` and `core_status` remain responsive after optional-runtime failure.
5. Core can inspect and repair the source/configuration responsible for that failure.
6. Core can request optional-runtime restart after repair.
7. Security authority is never broadened by fallback behavior.

## 16. Main design rule

For every future dependency ask:

> Does Core need this dependency in order to stay connected, diagnose failure, and repair the system?

If no, it belongs after the CORE READY boundary.


