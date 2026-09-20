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

V3 technical research: [V3 Technical Research](docs/research/V3_TECHNICAL_RESEARCH.md).

V3 is the complete target architecture: stateless Protocol Edge, Durable Run Kernel, transactional state, execution
and isolation substrate, one semantic Capability Catalog with versioned Bindings, Agent Runtime, Verified Assets,
bounded Skills, deterministic Orchestrator, approvals/resource leases, artifacts and multi-device evolution.

[Target Architecture V3-A](docs/architecture/TARGET_ARCHITECTURE_V3A.md) is only an implementation slice derived from
V3; it is not the definition of the target architecture.

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

Foundation V2 remains the implemented stable substrate. Architecture V3 is the complete research-backed target and
defines the contracts that future implementation slices must follow.

Key V3 decisions include:

- MCP is a stateless Protocol Edge, not P05 lifecycle state;
- one Durable Run Kernel and transactional State Store serve all long-running domains;
- Process, Terminal, Work Isolation and Security Isolation are separate primitives;
- one semantic Capability Catalog uses versioned implementation Bindings;
- Assets, Artifacts, Agents, Skills and Tasks have distinct contracts;
- ChatGPT provides high-level reasoning while the Orchestrator performs deterministic coordination.

Implementation sequencing is documented in V3/V3-A but does not narrow the target architecture.

## Canonical documents

- [Project Status](PROJECT_STATUS.md)
- [Target Architecture V3](docs/architecture/TARGET_ARCHITECTURE_V3.md)
- [V3 Technical Research](docs/research/V3_TECHNICAL_RESEARCH.md)
- [V3 Capability / Agent / Skill / Asset / Run Contracts](docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md)
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
- [Plugin Framework](docs/architecture/PLUGIN-FRAMEWORK.md)