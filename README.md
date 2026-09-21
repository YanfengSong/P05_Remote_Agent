# P05 Remote Agent

P05 is a local-first remote engineering Agent for controlled access to a Windows engineering workstation.

Design target:

**Remote Desktop Commander-like engineering ergonomics + explicit Workspace, policy, lifecycle, audit and plugin architecture.**

## Current baseline

Version: 0.3.1
Foundation: **V2**
Validated: 2026-09-20
Primary host: Windows + Node.js 22+

The core path is operational:

    ChatGPT
      -> tunnel / MCP
      -> P05 Agent
      -> Workspace / Policy
      -> Runtime
      -> Files / Git / Shell / Plugins / Downstream MCP
      -> Audit / Recovery

P05 can modify, build, test, restart and reconnect to itself through the controlled developer surface.

## Foundation V2

The stable foundation contracts are:

- Workspace Context + explicit authorization semantics;
- exactly one stable `platform-source` workspace;
- active-workspace confinement for structured tools;
- single core Capability Catalog;
- modular tool registration;
- common execution lifecycle;
- persistent metadata-only Audit/Recovery;
- application Plugin architecture;
- Workspace-aware downstream MCP binding.

Implemented baseline: [Target Architecture V2](docs/architecture/TARGET_ARCHITECTURE_V2.md).

Long-term target: [Target Architecture V3](docs/architecture/TARGET_ARCHITECTURE_V3.md).

V3 technical research:
- [V3 Technical Research](docs/research/V3_TECHNICAL_RESEARCH.md)
- [DeepSeek Harness / Cordis Benchmark](docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md)

V3 is now defined as a **two-kernel architecture**:

- Trust / Durable Kernel — identity, Workspace authority, immutable ExecutionContext, Policy/Approval, Durable Run,
  State/Invocation/Audit and security execution modes;
- Composition Kernel — Context, typed Services, Components/Fibers, structural E1 cleanup, reactive dependencies,
  scoped composition and declarative graph reconciliation/hot replacement.

Agent, Skill, semantic Capability/Binding, Application and Worker services compose above those kernels.

[Target Architecture V3-A](docs/architecture/TARGET_ARCHITECTURE_V3A.md) remains an implementation slice derived from
V3; it does not define or narrow the complete target architecture.

## Tool profiles

Profiles are cumulative and fail closed.

| Profile | Main implemented capabilities |
|---|---|
| discovery | `device_info`, `ping` |
| readonly | workspace/activity/recovery/plugin inspection, file read/list, Git status/diff |
| developer | workspace switch, file write/patch, `git_add`, `git_commit`, `git_branch`, platform validation, restart, downstream discovery, `shell_run` |
| full | developer + `git_push` + generic `mcp_call_tool` |

Temporary gated migration tools:
- `list_directory`
- `read_file`

## Workspace model

A Workspace is a registered logical project context, not merely a cwd.

Every explicit registry must contain exactly one `platform-source` workspace.

Structured file/Git operations are confined to the active Workspace. An absolute path into another registered Workspace is rejected.

P05 platform validation is different:

`command_run(check/build/verify/...)` always targets the platform-source workspace even when a business project is active.

## Git mutation

Developer:
- `git_add`
- `git_commit`
- `git_branch` with create/switch/safe delete

Full:
- `git_push`

Push is elevated because it mutates an external remote. The structured tool does not expose force push or arbitrary refspecs.

## Shell model

`shell_run` is available at developer.

Its starting cwd must remain inside the active Workspace, but the PowerShell command itself runs with the paired Windows user's authority.

This is deliberately a trusted-terminal model, **not a sandbox**.

A true hard shell boundary requires OS isolation or an external execution/approval broker.

See [Permission Model](docs/architecture/PERMISSION-MODEL.md).

## Runtime / Audit / Recovery

All exposed tools use the common lifecycle:

    prepare -> authorize -> execute -> verify -> complete
                          |
                          +-> failed -> recovery hint

Audit records include metadata such as:
- execution id;
- capability;
- scope;
- Workspace id;
- phase/state;
- duration;
- classified error;
- recovery hint.

They do **not** store raw commands, file contents or tool argument payloads.

Audit state is persisted under the protected P05 state directory. A record left running across an Agent restart becomes `interrupted`.

Inspection tools:
- `activity_recent`
- `recovery_status`

## Structured MCP outputs

Core MCP tools advertise `outputSchema` and return matching `structuredContent` while preserving text content for compatibility.

This gives clients typed results such as:
- Workspace objects/lists;
- Audit/recovery events;
- plugin status;
- file bytes/hash metadata;
- Git output;
- shell `stdout/stderr`;
- downstream MCP status/tool descriptors.

`verify` includes an output-schema regression that fails when a Core tool lacks an object-root output schema.

## Capability and registration model

Core capability metadata has one source of truth:

`src/capability/registry.ts`

Policy consumes that catalog instead of maintaining another metadata table.

`src/index.ts` is assembly/bootstrap only. Tool handlers live in registration modules.

## Application plugins

Application-specific integration does not belong in Agent Core.

Foundation V2 implements this through Plugins. Architecture V3 refines the model:

- Plugin = package/distribution/ownership;
- Component = runtime compositional unit;
- Fiber = one live Component instance.

Dynamic activation/dependency/cleanup belongs to the Composition Kernel, while authorization remains in the
Trust / Durable Kernel.

P05 has a plugin layer with:
- manifest/API version;
- permissions;
- capabilities;
- downstream definitions;
- lifecycle hooks;
- Workspace plugin allowlists.

MATLAB/Simulink is the first built-in application plugin. P05 Core no longer imports MATLAB-specific configuration or symbols.

Its downstream MCP supports:
- active Workspace binding;
- platform Workspace binding;
- fixed cwd binding.

## Restart broker

`runtime_restart` has no caller-controlled command/path parameters.

It can only request the externally provisioned:

    schtasks.exe /Run /TN P05-RestartBroker

This preserves the rule:

**Self-development is allowed; self-authorization is not.**

## Validation baseline

Latest Foundation V2 validation:

    ACTION verify             PASS
    POLICY_PROFILES_OK        238 checks
    PROFILE_EXPOSURE_OK       162 checks
    TEMP_READONLY_OK          49 checks
    FOUNDATION_OK             33 checks
    GIT_MUTATIONS_OK          13 checks
    PLUGIN_FRAMEWORK_OK       17 checks
    OUTPUT_SCHEMA_OK          71 checks
    DOWNSTREAM_SMOKE_OK       PASS

This is 583 explicit assertions/checks, plus build/typecheck and downstream smoke.

## Architecture direction

Foundation V2 remains the implemented stable substrate. Architecture V3 is the complete research-backed target.

The next-generation design combines two independent mechanisms:

1. **Durable execution** — Run/State/Invocation/Approval/Audit preserve work and authority across reconnect/restart.
2. **Dynamic composition** — Context/Component/Fiber/Effect/Coeffect make implementations scoped, dependency-aware,
   cleanly unloadable and hot-replaceable.

Hard boundaries:

- Context is dynamic composition; ExecutionContext is immutable authority/execution scope.
- Fiber is a live implementation instance; Run is durable work.
- only E1 local effects are automatic Fiber cleanup;
- E2 resources and E3/E4 engineering mutations use durable resource/Capability/Approval semantics;
- Composition Profiles never imply Permission/Tool Profiles;
- Trust Kernel modules are excluded from ordinary self-HMR.

DeepSeek Harness/Cordis is used as a technical benchmark for composition semantics, not copied as a security model.

Implementation sequencing is subordinate to these target contracts and should be frozen only after the listed V3 POCs.
## Canonical documents

- [Project Status](PROJECT_STATUS.md)
- [Target Architecture V3](docs/architecture/TARGET_ARCHITECTURE_V3.md)
- [Context Component Runtime](docs/architecture/CONTEXT-COMPONENT-RUNTIME.md)
- [V3 Technical Research](docs/research/V3_TECHNICAL_RESEARCH.md)
- [DeepSeek Harness / Cordis Benchmark](docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md)
- [V3 Run / Context / Capability / Agent / Skill / Asset Contracts](docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md)
- [Target Architecture V3-A — implementation slice](docs/architecture/TARGET_ARCHITECTURE_V3A.md)
- [Target Architecture V2 — implemented baseline](docs/architecture/TARGET_ARCHITECTURE_V2.md)
- [Permission Model](docs/architecture/PERMISSION-MODEL.md)
- [Tool Profiles](docs/architecture/TOOL-PROFILES.md)
- [ADR-0007 External Restart Broker](docs/adr/ADR-0007-external-restart-broker.md)
- [ADR-0008 Developer Shell Trust Model](docs/adr/ADR-0008-developer-shell-trust-model.md)
- [ADR-0009 Foundation V1](docs/adr/ADR-0009-foundation-v1.md)
- [ADR-0010 Foundation V2](docs/adr/ADR-0010-foundation-v2.md)
- [ADR-0011 Plugin Framework](docs/adr/ADR-0011-plugin-framework.md)
- [ADR-0012 Agent / Skill / Asset / Orchestrator Layering](docs/adr/ADR-0012-agent-skill-orchestrator.md)
- [ADR-0013 V3-A Execution & Agent Foundation](docs/adr/ADR-0013-v3a-execution-agent-foundation.md)
- [ADR-0014 Protocol Edge and Explicit Handles](docs/adr/ADR-0014-protocol-edge-explicit-handles.md)
- [ADR-0015 Durable Run Kernel and State](docs/adr/ADR-0015-durable-run-kernel-state.md)
- [ADR-0016 Host Session / Terminal / Isolation](docs/adr/ADR-0016-host-session-terminal-isolation.md)
- [ADR-0017 Capability Bindings and Assets](docs/adr/ADR-0017-capability-bindings-assets.md)
- [ADR-0018 Trust Kernel / Context Component Runtime](docs/adr/ADR-0018-trust-kernel-context-component-runtime.md)
- [Plugin Framework](docs/architecture/PLUGIN-FRAMEWORK.md)