# Project Status

Updated: 2026-09-20

## Baseline

Version: **0.3.1**
Branch: **main**
Repository: **YanfengSong/P05_Remote_Agent**
Milestone: **Foundation V2 operational**

P05 is now a multi-Workspace remote engineering Agent platform rather than a tool collection tied to the P05 source directory.

## Core path verified

    ChatGPT -> tunnel/MCP -> P05 -> Workspace/Policy -> Runtime
            -> Files/Git/Shell/Plugins/Downstream
            -> Audit/Recovery

Repeated runtime restart/reconnect has been verified.

## Foundation V2

### Workspace

- registered logical Workspaces;
- exactly one `platform-source`;
- active Workspace can be switched only by logical id;
- structured file access is confined to the active Workspace;
- Git operations target the active Workspace;
- shell starting cwd is confined to the active Workspace;
- optional Workspace plugin allowlist;
- roots are canonicalized and junction/symlink root escape is refused.

### Platform

`command_run` is explicitly bound to the platform-source root.

A business Workspace can be active while `command_run(check)` still validates P05.

### Capability / Policy

Core metadata has one canonical source:

`src/capability/registry.ts`

Descriptors carry:
- name;
- minimum profile;
- risk;
- scope;
- summary;
- optional gate.

Application-plugin capabilities are declared in their plugin manifest and merged into the session catalog.

### Registration

`src/index.ts` is bootstrap/assembly.

Tool groups are modular:
- control;
- fs;
- git;
- execution;
- temporary;
- gateway/plugin;
- device.

### Runtime

Common lifecycle:

    prepare -> authorize -> execute -> verify -> complete
                          |
                          +-> failed

Classified errors:
- policy;
- timeout;
- process;
- tool;
- config;
- interrupted;
- unknown.

### Audit / Recovery

Metadata-only audit is persisted under protected P05 state.

Remote inspection:
- `activity_recent`
- `recovery_status`

A record left running across Agent restart is converted to:
- failed;
- interrupted;
- recoveryHint=inspect.

Raw command text, file content and raw argument payloads are not stored.

### MCP output contracts

All current Core MCP tools advertise object-root `outputSchema` and return matching `structuredContent`.
Legacy text content is retained for compatibility.

Regression:
- `OUTPUT_SCHEMA_OK (71 checks)`;
- full + temporary tool surface is checked for output schemas;
- representative tools are called and verified to return structured objects.

### Operator Console

V2 local Operator Console is implemented on the `feat/v2-operator-console` branch.

Implemented:
- independent loopback GUI process on `127.0.0.1:56301`;
- connect / disconnect / restart controls;
- GUI survives P05 MCP/Tunnel restart;
- local token-protected control bridge from MCP runtime to GUI;
- live Workspace selection;
- Runtime/Tunnel/MCP/process status;
- structured Git visibility;
- Plugin/downstream visibility;
- persistent Audit/Recovery;
- memory-only sanitized Live Activity;
- MCP capability/exposure visibility;
- one-click local launcher.

Current automated regression:
- `OPERATOR_CONSOLE_OK (16 checks)`.

Current V2+Operator validation baseline: **602 minimum explicit checks**; hosts with the NTFS 8.3 short-name probe execute **603**. Build/typecheck and downstream smoke are additional gates.

### Plugins / Downstream

Application-specific integrations use the Plugin layer.

MATLAB/Simulink is the first built-in plugin.

Downstream MCP processes can bind to:
- active Workspace;
- platform Workspace;
- fixed cwd.

Workspace switching changes active-bound downstream context and triggers reconnect when required.

## Current profiles

### discovery
- device_info
- ping

### readonly
- workspace_list
- workspace_current
- activity_recent
- recovery_status
- plugin_list
- fs_read / fs_list
- git_status / git_diff / git_diff_stat

### developer
- all readonly capabilities
- workspace_switch
- fs_write / apply_patch
- git_add / git_commit / git_branch
- command_run
- runtime_restart
- mcp_status / mcp_list_tools
- shell_run

### full
- all developer capabilities
- git_push
- mcp_call_tool

Temporary read-only migration tools remain gated by `P05_TEMP_READONLY_ROOT`.

## Git mutation

Implemented and tested:
- stage explicit Workspace paths;
- local commit;
- branch create;
- branch switch;
- safe branch delete (`-d`, no force);
- push current HEAD to named remote.

`git_push` remains `full` because it modifies an external remote.

No structured force push or arbitrary refspec is exposed.

## Shell boundary

`shell_run` follows the trusted-terminal model.

Technical boundary:
- initial cwd must be inside active Workspace.

Not a technical boundary:
- the PowerShell command itself can use Windows-user authority outside that Workspace.

Operating rule:
- persistent outside-Workspace changes require explicit user approval unless an external broker pre-authorizes them.

Hard technical shell confinement requires OS isolation.

## Validation

Latest full verification:

    ACTION verify                 PASS
    ACTION check                  PASS
    ACTION build                  PASS
    DOWNSTREAM_SMOKE_OK           PASS
    POLICY_PROFILES_OK            240 checks
    PROFILE_EXPOSURE_OK           161-162 checks
    TEMP_READONLY_OK              49 checks
    FOUNDATION_OK                 35 checks
    GIT_MUTATIONS_OK              13 checks
    PLUGIN_FRAMEWORK_OK           17 checks
    OUTPUT_SCHEMA_OK              71 checks
    OPERATOR_CONSOLE_OK           16 checks

Key V2 acceptance verified:
- cross-Workspace absolute structured write refused;
- cross-Workspace absolute structured read refused;
- refused writes create no side effects;
- platform self-validation survives business Workspace activation;
- platform root remains stable after Workspace switch;
- Capability Catalog is canonical;
- Runtime errors are classified;
- interrupted records survive reload as recovery records;
- downstream target follows Workspace binding;
- Git mutation works against isolated local repositories/remotes;
- Core starts with zero application plugins;
- plugin capability metadata merges into the session Capability Catalog;
- plugin tools are refused after switching to a Workspace that disables the plugin;
- plugin start failure is isolated from Core;
- Core index has no MATLAB-specific import/symbol.

## Remaining foundation boundary

The major residual security boundary is arbitrary shell.

P05 intentionally does not pretend a command blacklist can sandbox PowerShell.

A future Approval/Execution Broker or OS-isolated worker can add hard containment without changing the Foundation V2 contracts.

## Next capability work

1. Process / persistent Terminal Session Manager.
2. asynchronous Search.
3. higher-level Git convenience tools if needed.
4. MATLAB/Simulink adapters on the plugin layer.
5. multi-device.
6. optional GUI / isolated worker.

## Working tree

Foundation V1, Git mutation and Foundation V2 work are still part of the current uncommitted working tree.

`main` was already ahead of `origin/main` before this sequence. Review commit history before push.
## Plugin architecture references

- `docs/architecture/PLUGIN-FRAMEWORK.md`
- `docs/adr/ADR-0011-plugin-framework.md`

## Target Architecture V3

Architecture V3 is **accepted as the long-term target but is not yet fully implemented**.

The fixed target stack is:

```text
ChatGPT
  -> Orchestrator
  -> Skill / Workflow Engine
  -> Meta-Capability / Capability
  -> Plugin / Agent Provider / Verified Asset / Core primitive
  -> P05 Core Runtime
  -> Host / Applications
```

Layer meanings:
- Plugin = optional capability/provider extension;
- Agent = execution actor;
- Skill = reusable bounded process;
- Asset = verified versioned implementation material;
- Orchestrator = coordination;
- Core = generic authorization/execution substrate.

V3 acceptance rules include:
- concrete Agents enter through Agent Provider Plugins;
- Skills reference Capability IDs rather than filenames/providers;
- Script Assets require version/hash/verification lifecycle;
- writing Agents use isolated worktree/session roots;
- Plugin/Agent/Skill/Orchestrator execution cannot bypass Core Policy/Runtime/Audit;
- parallel results require explicit reconcile before integration.

Canonical V3 documents:
- `docs/architecture/TARGET_ARCHITECTURE_V3.md`
- `docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md`
- `docs/adr/ADR-0012-agent-skill-orchestrator.md`

Implementation priority:
1. Process / persistent Terminal Sessions.
2. Agent Runtime + reference Provider.
3. worktree/session isolation + reconciliation.
4. Verified Asset Registry + Meta-Capability.
5. Skill Runtime.
6. Orchestrator.
