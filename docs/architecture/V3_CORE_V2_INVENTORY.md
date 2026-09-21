# P05 V3 Core — V2 Inventory and Migration Map

Status: architecture inventory
Branch: v3
Basis: current V2 source tree and live MCP exposure on 2026-09-21
Parent contract: V3_CORE_CONTRACT.md

## 1. Executive finding

V2 already contains most of the practical "hands and feet" required by V3 Core.

The V3 Core migration is therefore NOT a rewrite. The primary work is:

1. preserve proven device/workspace/file/Git/policy/recovery primitives;
2. remove optional subsystem startup dependencies from the Core boot path;
3. add Recovery Mode and safe degraded startup;
4. separate diagnostic/supervision surfaces from plugin/downstream implementations;
5. remove non-recovery business/external operations from the Core surface.

Estimated architectural reuse: high. Most low-level file, Git, workspace, device, policy and activity code can be retained with bounded hardening.

## 2. Current V2 startup path

Current boot in `src/index.ts` is approximately:

```text
MCP Server
  -> config + workspace registry
  -> PluginRegistry(BUILTIN_PLUGINS)
  -> PluginRuntime.startAll()
  -> CapabilityCatalog + plugin capabilities
  -> DownstreamRegistry(plugin downstream definitions)
  -> AuditStore
  -> ExecutionRuntime
  -> Core tool registration
  -> downstream MCP tool registration
  -> plugin tool registration
  -> optional local operator bridge
```

This means V2 Core still has direct startup-time knowledge of optional plugins and downstream definitions.

## 3. Current fatal startup coupling points

### F-01 Configuration import can abort the whole Core

`src/config.ts` validates allowed roots and other settings during module import.

This is correct fail-closed behavior for authority, but V3 needs a distinction between:

- unsafe configuration -> refuse privileged operations;
- optional/broken configuration -> still expose a minimal Recovery Mode.

No fallback may silently widen authority.

### F-02 Workspace persisted state can abort the whole Core

`loadPersistentWorkspaceEntries()` throws on malformed persisted JSON and the exception reaches boot.

V3 should quarantine invalid persisted optional workspace state and keep the trusted platform recovery workspace available.

### F-03 Plugin catalog/registry can abort the whole Core

Current boot imports `BUILTIN_PLUGINS`, constructs `PluginRegistry`, validates dependencies/capabilities, and registers plugin tools in-process.

Malformed plugin metadata, duplicate capability/downstream IDs, import-time failures, or registration errors can therefore prevent or destabilize Core startup.

V3 Core must not require plugin code to boot.

### F-04 Downstream MCP definitions are constructed during Core boot

`DownstreamRegistry` is created directly from plugin-provided definitions.

Downstream MCP is optional functionality. Its definition/configuration failures must be observable but must not determine whether Core MCP is online.

### F-05 Audit state corruption can abort startup

`AuditStore` throws when persisted audit state is invalid.

For V3, audit integrity remains important, but corrupted diagnostic history must be quarantined/reported rather than making the repair plane unavailable.

## 4. Module classification

| Area / source | V3 Core decision | Required change |
|---|---|---|
| `device/identity.ts` | KEEP | Retain as built-in Core identity. |
| `workspace/manager.ts` | KEEP + HARDEN | Preserve boundaries; add Recovery Mode behavior for invalid optional workspace state. |
| `workspace/persistence.ts` | KEEP + HARDEN | Quarantine corrupt persisted entries instead of taking Core offline. |
| `security.ts` | KEEP | Core path/sensitive-file enforcement remains foundational. |
| `policy/expose.ts` | KEEP | Stable built-in MCP exposure and call-time enforcement remain Core. |
| `policy/tool-profile.ts` | KEEP + HARDEN | Invalid profile must fail closed without necessarily killing minimum Recovery Mode. |
| `tools/device.ts` | KEEP | `ping` and `device_info` are minimum Core tools. |
| `tools/files.ts`, `register-fs.ts` | KEEP | File list/read/write/exact patch are recovery primitives. |
| `tools/git.ts`, `register-git.ts` | SPLIT | Keep local status/diff/add/commit/safe branch. Move `git_push` outside Core. |
| `audit/store.ts` | KEEP + HARDEN | Preserve bounded recovery history; quarantine corrupt state. |
| `monitor/live-activity.ts` | KEEP | Useful Core observability with bounded/redacted metadata. |
| `runtime/execution.ts` | KEEP + SIMPLIFY | Retain common authorize/execute/verify/audit wrapper for Core operations. |
| `tools/runtime.ts` | KEEP | Controlled Core/runtime restart remains a recovery primitive. |
| `tools/shell.ts` | KEEP AS BREAK-GLASS | Explicit, policy-controlled, audited; never normal plugin API. |
| `tools/dev-command.ts` | KEEP + NARROW | Keep only allowlisted Core validation/repair actions; plugin/downstream tests are not Core responsibility. |
| `capability/registry.ts` | SPLIT | Keep a static Core tool descriptor catalog; dynamic plugin capability catalog is outside V3 Core. |
| `plugin/*` | OUTSIDE CORE | Plugin framework remains separately developed; Core must not import plugin implementations to boot. |
| `plugins/*` | OUTSIDE CORE | MATLAB/example/domain packages are optional. |
| `downstream/client.ts` | OUTSIDE CORE | Downstream execution is optional. |
| `downstream/registry.ts` | OUTSIDE CORE / ADAPTER | Core may consume status through a fault-tolerant supervisor boundary only. |
| `gateway-tools.ts:mcp_status` | KEEP SEMANTICALLY | Core needs optional-subsystem status, but implementation must not require downstream registry health. |
| `gateway-tools.ts:mcp_list_tools` | OUTSIDE CORE | Not required to repair Core. |
| `gateway-tools.ts:mcp_call_tool` | OUTSIDE CORE | Business/extension execution, not survival/recovery. |
| `operator/bridge.ts` | OUTSIDE CORE PROCESS | UI/control bridge is optional; Core may expose equivalent internal status contracts without depending on UI. |
| `operator/ui.ts`, `operator/server.ts` | OUTSIDE CORE | Operator GUI is an optional client/control surface. |
| temporary `list_directory/read_file` | RETIRE | Legacy duplicate surface; canonical Core fs tools already exist. |

## 5. MCP tool classification

### Keep as V3 Core built-ins

- `ping`
- `device_info`
- `workspace_list`
- `workspace_current`
- `workspace_switch`
- `fs_list`
- `fs_read`
- `fs_write`
- `apply_patch`
- `git_status`
- `git_diff`
- `git_diff_stat`
- `git_add`
- `git_commit`
- `git_branch`
- `activity_recent`
- `recovery_status`
- `runtime_restart`
- controlled `shell_run`

### Keep only after refactoring the dependency

- `plugin_list`: Core needs optional subsystem status, but MUST NOT require `PluginRuntime` to boot.
- `mcp_status`: Core needs downstream health/status visibility, but MUST tolerate no downstream subsystem.
- `command_run`: retain only as a narrow allowlisted Core verify/repair action surface.

### Remove from Core surface

- `git_push`
- `mcp_list_tools`
- `mcp_call_tool`
- temporary `list_directory`
- temporary `read_file`
- all `matlab.*`
- all future STM32/domain/plugin tools

## 6. Missing V3 Core capabilities

| Gap | Why it matters | V3 requirement |
|---|---|---|
| Recovery Mode | Broken optional state can currently prevent repair access. | Boot minimum MCP without optional extensions. |
| Core-only bootstrap graph | `index.ts` currently imports/constructs optional systems. | Core startup graph must end before extension loading begins. |
| Optional subsystem supervisor contract | Core can inspect plugins but is coupled to their runtime type. | Generic status/disable/restart boundary with null-safe implementation. |
| Corrupt-state quarantine | Workspace/audit corruption can stop boot. | Rename/quarantine invalid state, report it, keep safe minimum Core. |
| Startup health phases | `ping` only proves process response. | Expose `boot/core/optional` readiness separately. |
| Explicit degraded state | Optional failure is not a first-class Core mode. | `healthy / degraded / recovery` Core state. |
| Core self-test | Current `command_run` verifies many optional features. | Small deterministic Core-only verification suite. |
| Core/extension dependency test | No hard test guarantees Core boots without plugins. | CI test with all optional extension imports disabled/absent. |

## 7. Proposed V3 Core boot graph

```text
Process Supervisor / Tunnel
          |
          v
Core Bootstrap
  -> Core Config / Authority Root
  -> Device Identity
  -> Platform Recovery Workspace
  -> Policy
  -> Core Audit (degradable)
  -> Core MCP Server
  -> Built-in Recovery Tools
          |
          +---- CORE READY ----+
                               |
                               v
                     Optional Runtime Adapter
                       -> plugin system
                       -> downstream MCP
                       -> operator UI
                       -> future Agent/Skill
```

The Core becomes reachable before optional runtime loading.

Optional loading failure changes Core state to `degraded`; it does not take the MCP endpoint offline.

## 8. Migration rule

V3 SHALL NOT rewrite proven V2 primitives unless a concrete Core survivability requirement demands it.

Migration sequence:

1. freeze the V3 Core built-in tool list;
2. split `src/index.ts` into Core bootstrap and optional-runtime attach phases;
3. introduce Recovery Mode and degraded-state reporting;
4. harden persisted workspace/audit/config failure handling without widening authority;
5. move external/non-recovery tools out of Core exposure;
6. add no-plugin/no-downstream/fault-injection acceptance tests.

Plugin API redesign is explicitly out of scope for this migration.

## 9. Acceptance targets for the migration

1. Remove/disable all optional plugins: Core still starts and ChatGPT can connect.
2. Make one plugin import/manifest invalid: Core still starts in degraded/recovery mode.
3. Corrupt downstream MCP configuration: Core remains available.
4. Corrupt optional workspace persisted state: trusted platform recovery workspace remains available.
5. Corrupt audit history: Core reports quarantine and remains available.
6. Use only Core tools to inspect, patch and locally commit a repair.
7. Verify `git_push`, downstream arbitrary execution and domain tools are absent from the Core-only profile.
8. Verify external persistent-write and break-glass policy remains fail closed.

## 10. Immediate implementation target

The first V3 code change should be **Core Bootstrap Separation**, not Run/Fiber/Agent work.

Target result:

```text
startCore()
  -> returns a usable MCP recovery plane

attachOptionalRuntime(core)
  -> best effort
  -> failure => degraded status
  -> never invalidates Core readiness
```

This is the smallest code change that directly advances the user's V3 goal: keep ChatGPT connected to a capable local Core even when everything optional is broken.
