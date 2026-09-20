# P05 Target Architecture V2

Status: implemented Foundation V2 baseline; long-term target superseded by TARGET_ARCHITECTURE_V3.md
Date: 2026-09-20

## Definition

P05 is a remote engineering Agent platform.

Application-specific automation is not part of P05 Core. MATLAB, Simulink, STM32CubeIDE, CANoe and future
engineering applications are Application Plugins built on the same Core contracts.

```text
ChatGPT / MCP Client
        |
        v
+------------------------------+
|           P05 Core           |
| Device / Workspace / Policy  |
| Capability / Runtime / Audit |
| Recovery / Process / Broker  |
+--------------+---------------+
               |
        +------v-------+
        | Plugin       |
        | Framework    |
        | manifest     |
        | registry     |
        | lifecycle    |
        +------+-------+
               |
   +-----------+--------------------+
   |           |                    |
+--v----+  +---v------+       +-----v----+
|MATLAB |  | STM32    |  ...  | CANoe    |
|plugin |  | plugin   |       | plugin   |
+-------+  +----------+       +----------+
```

## Core invariants

### Workspace is context and structured authorization boundary

Each registered workspace has:
- logical id;
- canonical real root;
- kind;
- authorization semantics;
- optional plugin allowlist.

Structured File/Git operations must remain inside the active workspace, even when the caller supplies an absolute
path that is inside a different authorized workspace.

Workspace registration itself is startup/operator configuration. Remote callers can switch only by registered id.

### One explicit platform workspace

Exactly one workspace is `platform-source`.

P05 platform operations such as `command_run(verify)` bind to that platform workspace and do not follow the active
business workspace.

### Capability Registry is the metadata source of truth

Every capability declares:
- name;
- minimum profile;
- risk;
- scope;
- optional gate;
- summary.

Core and plugin capabilities merge into one runtime `CapabilityCatalog`.

Policy, Exposer and Execution Runtime consume the same catalog instance.

### Execution lifecycle

```text
prepare -> authorize -> execute -> verify -> complete
                            |
                            v
                         failed
                            |
                       audit/recover
```

Audit classifies errors into policy / timeout / process / tool / config / interrupted / unknown.

Persistent audit converts an execution left in `running` state during restart into an interrupted recovery record.

### Shell is explicitly different

Structured tools enforce the active-workspace boundary.

`shell_run` starts inside the active workspace, but it executes with the paired Windows user's OS authority.
It is a trusted-terminal capability, not a workspace sandbox.

Hard isolation requires a restricted account, container, VM or dedicated worker.

## Plugin Framework

### Plugin contract

Every plugin declares a manifest containing:
- stable plugin id;
- label;
- plugin version;
- P05 plugin API version;
- enabled state;
- contributed capabilities;
- permission declaration;
- optional dependencies.

Plugin capabilities must use the plugin id prefix, for example:
- `matlab.run`
- `stm32.build`
- `stm32.flash`

Plugins cannot overwrite Core or another plugin's capability metadata.

### Loading model

Foundation V2 supports explicitly compiled-in plugins only.

P05 does NOT:
- scan arbitrary plugin directories;
- import a path supplied by a remote caller;
- execute an unsigned plugin package from a Workspace.

This keeps "plugin" from becoming a generic arbitrary-code loader.

Future independently distributed plugins require an authenticated package model or an isolated plugin host.

### Workspace activation

A workspace may provide a plugin allowlist.

An installed plugin must satisfy both:
1. plugin is globally enabled;
2. plugin is allowed by the active workspace.

Plugin tools are wrapped by the Core Exposer, so remote calls still pass through Policy, Execution Runtime and Audit.
Plugin-owned downstream MCP connections are checked against the same active-workspace activation rule.

### Failure isolation

Plugin start failures are recorded as plugin-local `failed` state and do not abort P05 Core startup.

Removing or disabling an application plugin must leave Core operational.

## Adapter priority

Application plugins should prefer stable automation interfaces in this order:

1. MCP / documented API;
2. CLI / build system;
3. debugger protocols such as GDB;
4. application scripting APIs;
5. GUI automation only when no stable programmatic interface exists.

## Current application plugin

MATLAB / Simulink is the reference plugin.

Core no longer imports MATLAB-specific configuration. The MATLAB plugin contributes a generic downstream MCP
definition with workspace binding:
- active by default;
- fixed only when an explicit MATLAB MCP cwd is configured.

High-level `matlab.*` capabilities will be added only when their typed adapters are implemented.

## Capability roadmap

After the foundation:
1. Process / Terminal Sessions;
2. asynchronous Search;
3. high-level Git workflow helpers and approval-aware remote effects;
4. MATLAB / Simulink plugin capabilities;
5. STM32CubeIDE / ST-Link plugin;
6. CANoe and other domain plugins;
7. multi-device orchestration;
8. optional GUI / isolated workers.

Application capabilities must not require changes to Workspace/Security Core unless a new generic Core primitive is
actually needed.