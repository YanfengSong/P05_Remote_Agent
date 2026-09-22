# P05 V3 Core Contract

Status: Accepted Core baseline; boundary frozen by V3_CORE_BOUNDARY_RULE.md

Normative Core sub-designs:
- V3_CORE_BOOTSTRAP_DESIGN.md
- V3_CORE_CONNECTION.md
- V3_CORE_ROUTING.md
- V3_CORE_SUPERVISION.md
- V3_CORE_LIFECYCLE.md
- V3_CORE_RESOURCE_GUARD.md
- V3_CORE_INSTANCE_MODEL.md
- V3_PLATFORM_PORTABILITY.md
Branch: v3

## 1. Core mission

P05 Core is the always-available local control and recovery plane between ChatGPT/AI clients and the host computer.

The Core MUST remain operational without MATLAB, STM32, Agent, Skill, Workflow, downstream MCP, or any other business plugin.

V3 is an evolutionary upgrade of V2. Existing validated V2 capabilities, including independent A/B Runtime Slots with separate Workspace bindings, are inherited unless a concrete V3 requirement justifies changing their implementation.

Its job is not to provide every feature. Its job is to keep the host reachable, observable, controllable, and repairable.

> Optional capabilities may improve what P05 can do, but they must never be required for P05 Core to stay online and repair the system.

## 2. Core boundary

The Core owns only capabilities required to:

1. establish and maintain the AI-to-host MCP connection;
2. identify the device and active workspace;
3. inspect local state required for diagnosis;
4. perform bounded repair operations;
5. enforce policy and approvals;
6. supervise optional runtimes/plugins;
7. expose health, audit, failure and recovery information.

Everything else is optional and must live outside the Core.

## 3. Minimum Core modules

### 3.1 Protocol Edge

Responsibilities:

- MCP server lifecycle;
- protocol/version compatibility boundary;
- stable built-in tool exposure;
- connection health;
- request validation;
- error containment.

The Protocol Edge MUST NOT depend on any optional plugin.

### 3.2 Device Identity

Responsibilities:

- stable local device identity;
- host/runtime information;
- Core version/build identity;
- startup timestamp and health.

### 3.3 Workspace Control

Responsibilities:

- register/list workspaces;
- select active workspace;
- enforce workspace boundaries;
- expose workspace identity without leaking unnecessary host paths.

Existing repair actions MUST NOT be silently retargeted by later workspace switches.

### 3.4 Recovery File Operations

Built-in recovery operations:

- list directory;
- read file;
- create/replace text file;
- exact patch with precondition/hash verification.

These operations belong in Core because repairing configuration, source, manifests and scripts must remain possible when optional runtimes are broken.

### 3.5 Recovery Git Operations

Built-in recovery operations:

- status;
- diff/diff-stat;
- stage explicit paths;
- local commit;
- safe branch create/switch/delete.

Remote publish, release and other irreversible repository operations are not required Core capabilities.

### 3.6 Runtime Supervision

Core MUST be able to inspect and control P05-owned optional runtimes:

- list plugin/runtime state;
- inspect downstream MCP state;
- disable a failing optional component;
- restart a provisioned runtime;
- expose recovery status.

Failure of an optional runtime MUST NOT terminate the Core MCP process.

### 3.7 Policy and Approval

All Core mutation/recovery operations remain subject to policy.

The Core MUST preserve:

- workspace boundary enforcement;
- sensitive-path protection;
- external persistent-write approval;
- fail-closed behavior;
- explicit separation between structured safe tools and break-glass execution.

### 3.8 Diagnostics and Audit

Core MUST expose enough information to diagnose itself and optional components:

- health;
- recent activity metadata;
- failure category;
- runtime/plugin state;
- recovery hint;
- bounded logs/diagnostics where available.

Audit or diagnostic failure MUST degrade gracefully and MUST NOT make the Core unavailable.

## 4. Break-glass execution

A controlled shell/command repair path MAY exist in Core because some failures cannot be repaired through structured tools alone.

It MUST be treated as a break-glass capability:

- never used as the normal plugin API;
- never treated as a sandbox;
- subject to explicit authority/policy;
- auditable;
- unable to silently expand structured permissions.

## 5. Recovery Mode

V3 Core SHOULD support a Recovery Mode.

Recovery Mode starts the minimum Core without loading optional plugins/components when:

- optional plugin loading fails;
- optional configuration is invalid;
- repeated optional runtime crashes are detected;
- the operator explicitly requests safe startup.

Recovery Mode MUST still expose the minimum recovery surface needed to diagnose and repair the system.

## 6. Explicitly outside Core

The following are not Core responsibilities:

- MATLAB domain functions;
- STM32 domain functions;
- compiler/build-system integrations;
- Agent providers;
- Skill runtime;
- Workflow/Orchestrator business logic;
- application-specific automation;
- third-party downstream MCP servers;
- model-specific prompts/assets;
- project-specific tools.

These may be installed, enabled, disabled, upgraded or removed without changing Core survivability.

## 7. Core dependency rule

Allowed dependency direction:

```text
AI / ChatGPT
    |
    | MCP
    v
P05 Core
    |
    +-- optional Plugin / Component
    +-- optional Agent Runtime
    +-- optional Application Integration
    +-- optional downstream MCP
```

Forbidden direction:

```text
P05 Core --> requires MATLAB/STM32/Agent/Workflow/plugin to boot
```

Optional systems may depend on Core contracts.
Core MUST NOT depend on optional systems for startup or recovery.

## 8. Minimum built-in recovery surface

The exact MCP names may evolve, but the Core MUST provide equivalents of:

- ping / health;
- device_info;
- workspace_list / workspace_current / workspace_switch;
- fs_list / fs_read / fs_write / apply_patch;
- git_status / git_diff / git_add / git_commit / safe branch operations;
- plugin/runtime status;
- downstream MCP status;
- activity/recovery status;
- provisioned runtime restart;
- controlled break-glass shell.

This is a recovery surface, not the complete future product API.

## 9. Core invariants

CORE-I01: Core boots with zero optional plugins installed.

CORE-I02: One optional plugin/runtime crash cannot terminate Core.

CORE-I03: Optional configuration failure cannot prevent Recovery Mode startup.

CORE-I04: Core exposes enough file/Git/runtime operations to repair optional layers.

CORE-I05: Policy/approval cannot be bypassed by plugins or recovery tooling.

CORE-I06: Core MCP tool contracts remain backward-compatible across ordinary plugin upgrades.

CORE-I07: Plugin/downstream MCP availability is observable independently from Core health.

CORE-I08: Core can disable or restart a failing P05-owned optional runtime without requiring that runtime to be healthy.

CORE-I09: Break-glass execution is explicit, controlled and auditable.

CORE-I10: Business/domain features never become Core startup dependencies.

CORE-I11: Remote connection failure does not invalidate local Core readiness.

CORE-I12: Optional route conflicts or incompatibility cannot replace Core routes or stop Core.

CORE-I13: Optional Runtime restart is bounded by crash-loop/restart-budget policy.

CORE-I14: Core upgrade preserves a last-known-good rollback path controlled outside the active Core process.

CORE-I15: Core enforces bounded concurrency, time, output and diagnostic retention so optional work cannot starve recovery.

CORE-I16: Core control semantics are platform-neutral; Windows/Linux host mechanics are isolated behind Host Adapter/Bootstrap boundaries.

## 10. Acceptance tests

V3 Core is not accepted until all of the following pass:

1. Start Core with no optional plugins installed and connect from ChatGPT.
2. Corrupt or disable one optional plugin; Core ping/device/workspace tools continue to work.
3. Cause optional plugin initialization to throw; Core remains available and reports the failure.
4. Read and patch the failing plugin/configuration using only Core tools.
5. Inspect Git diff and create a local repair commit using only Core tools.
6. Restart or disable the failing optional runtime through Core supervision.
7. Verify policy still denies an unauthorized external persistent write.
8. Verify downstream MCP outage does not affect Core availability.
9. Verify malformed optional configuration cannot prevent Recovery Mode startup.
10. Verify Core can report why an optional subsystem failed without importing that subsystem's business logic.

## 11. Design test for future changes

Before adding anything to Core, ask:

> If this capability is absent, can ChatGPT still connect to the host, diagnose the system, repair it, and restore optional functionality?

If the answer is yes, the capability SHOULD remain outside Core.

If the answer is no, it may belong in Core, but only after proving that it is required for survivability or recovery.




