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
    POLICY_PROFILES_OK            238 checks
    PROFILE_EXPOSURE_OK           162 checks
    TEMP_READONLY_OK              49 checks
    FOUNDATION_OK                 33 checks
    GIT_MUTATIONS_OK              13 checks
    PLUGIN_FRAMEWORK_OK           17 checks
    OUTPUT_SCHEMA_OK              71 checks

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

## Architecture V3 research baseline

The complete V3 target architecture is now defined independently of implementation slicing.

The research-backed target adds:

- stateless Protocol Edge and explicit application handles;
- Durable Run Kernel + transactional State Store;
- separate Process, Terminal, Work Isolation and Security Isolation contracts;
- effect/idempotency-aware execution and durable approvals/resource leases;
- one semantic Capability Catalog with versioned Bindings;
- distinct Asset and Artifact lifecycles;
- provider-neutral Agent Runtime;
- bounded Skill Runtime;
- deterministic Orchestrator;
- multi-device and optional isolated/GUI Worker extension points.

V3-A remains one possible early implementation slice and MUST conform to the complete V3 contracts rather than define
or narrow them.

## Working tree

Foundation V1, Git mutation and Foundation V2 work are still part of the current uncommitted working tree.

`main` was already ahead of `origin/main` before this sequence. Review commit history before push.
## Plugin architecture references

- `docs/architecture/PLUGIN-FRAMEWORK.md`
- `docs/adr/ADR-0011-plugin-framework.md`

## Target Architecture V3

Architecture V3 is **accepted as the complete long-term target and technical research baseline; it is not yet fully
implemented**.

Canonical target stack:

```text
Client / ChatGPT
  -> Protocol Edge
  -> Orchestrator / Skill / Agent / Capability services
  -> Policy + Durable Run Kernel + Execution Runtime
  -> Capability Binding / Plugin / Verified Asset
  -> Host Session / Process / Terminal / Worker / Isolation
  -> Engineering host / applications / hardware
```

Key V3 decisions:

- MCP transport/session state is not P05 application state;
- long-running domains share one Durable Run Kernel;
- SQLite is the reference local transactional State Store behind an abstraction;
- Process and interactive Terminal Drivers are separate;
- Git worktree isolation is not an OS sandbox;
- Capabilities are semantic contracts with versioned implementation Bindings;
- Capability effect class constrains retry/recovery;
- Agents are actors, not Capabilities;
- Skills are typed bounded workflows;
- Orchestrator is deterministic coordination, while ChatGPT remains the high-level reasoning authority;
- Assets are reusable implementations; Artifacts are Run outputs;
- parallel writers require explicit reconciliation;
- device-local authority remains authoritative in future multi-device execution.

Canonical V3 documents:

- `docs/architecture/TARGET_ARCHITECTURE_V3.md`
- `docs/research/V3_TECHNICAL_RESEARCH.md`
- `docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md`
- `docs/architecture/TARGET_ARCHITECTURE_V3A.md` (implementation slice only)
- `docs/adr/ADR-0012-agent-skill-orchestrator.md`
- `docs/adr/ADR-0014-protocol-edge-explicit-handles.md`
- `docs/adr/ADR-0015-durable-run-kernel-state.md`
- `docs/adr/ADR-0016-host-session-terminal-isolation.md`
- `docs/adr/ADR-0017-capability-bindings-assets.md`

## V3 composition-kernel refinement

The complete V3 target now adds a second, orthogonal runtime mechanism below Agent/Skill/Application layers:

- **Trust / Durable Kernel** — identity, Workspace authority, immutable ExecutionContext, Policy/Approval, Durable Run, State/Invocation/Audit and security execution modes;
- **Composition Kernel** — Context, typed Service graph, Component/Fiber lifecycle, E1 local-effect ownership, reactive dependencies, scoped composition and graph reconciliation.

Critical boundaries:

- Context is live composition state; ExecutionContext is immutable execution/authority state.
- Fiber is one live Component instance; Run is durable work.
- Plugin is package/distribution/ownership; Component is the runtime composition unit.
- only E1 local effects are automatic Fiber cleanup.
- E2 resources and E3/E4 engineering mutations remain durable execution/resource effects.
- provider retirement blocks new selection before bounded drain/quiescence.
- Composition Profiles/Bundles never imply Permission/Tool Profiles.
- the Trust/Durable Kernel is excluded from ordinary self-HMR.

DeepSeek Harness/Cordis is the benchmark for Context/Fiber/Effect/reactive-dependency semantics, not a security model copied wholesale.

Additional canonical documents:

- `docs/architecture/CONTEXT-COMPONENT-RUNTIME.md`
- `docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md`
- `docs/adr/ADR-0018-trust-kernel-context-component-runtime.md`

Additional composition POCs:

7. typed Context/Service graph with provide/require/isolate/intercept;
8. Fiber structural cleanup and async drain;
9. dependency loss/reappearance lifecycle;
10. Agent/Workspace scoped Capability/Tool contribution layers;
11. provider hot replacement while durable Run metadata survives;
12. Shadow Context candidate validation;
13. declarative Component graph reconciliation;
14. E1/E2/E3/E4 effect-class enforcement.

V3-A remains an implementation slice derived from the complete V3 target and cannot redefine or narrow these contracts.
Technical POCs still required before freezing implementation technology:

1. MCP 2026-07-28 + current tunnel/client compatibility;
2. node-pty/ConPTY interactive Agent sessions;
3. Windows Job Object process-tree supervision;
4. SQLite crash/recovery/concurrency behavior;
5. parallel Git worktree reconciliation;
6. Windows Sandbox/isolated Worker suitability.
