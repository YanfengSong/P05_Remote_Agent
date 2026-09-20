# P05 Target Architecture V3

Status: target architecture; not fully implemented
Date: 2026-09-20
Implemented baseline: Foundation V2
First implementation slice: TARGET_ARCHITECTURE_V3A.md / 0.4.x

## Definition

P05 is a remote engineering Agent platform whose durable value is a reusable engineering execution system, not a
collection of application-specific MCP tools.

The target stack is:

```text
ChatGPT
  |
  v
Orchestrator
  |
  v
Skill / Workflow Engine
  |
  v
Meta-Capability / Capability Catalog
  |
  +---------------------+-------------------------+
  |                     |                         |
  v                     v                         v
Application Plugin   Agent Provider Plugin   Core Capability
  |                     |                         |
  v                     v                         v
Verified Script      Local Agent Session      Files/Git/Process
Asset / Adapter      / Worktree              / Broker
  _____________________|_________________________/
                        |
                        v
                 P05 Core Runtime
          Policy / Execute / Verify / Audit
                        |
                        v
               Local Host / Applications
```

The layers are intentionally distinct:

- **Plugin = capability/provider extension**
- **Agent = execution actor**
- **Skill = reusable process**
- **Asset = verified implementation material**
- **Orchestrator = coordination**
- **Core = generic authorization/execution substrate**

These layers MUST NOT be collapsed into one another.

## Current implemented baseline

Foundation V2 already provides:
- Workspace Context and active-workspace structured boundary;
- one explicit platform-source workspace;
- Capability Catalog;
- Policy / Execution Runtime;
- persistent metadata-only Audit / Recovery;
- modular tool registration;
- Git structured mutation;
- Plugin Framework;
- Workspace-aware downstream MCP;
- MATLAB as an Application Plugin.

V3 extends this baseline without redefining those contracts.

# Layer 1 — P05 Core

Core owns only generic engineering-agent primitives:

- Device connection and identity;
- Workspace registry/context/authorization;
- Capability Catalog;
- Policy and approval decisions;
- Execution Runtime;
- Process / persistent Terminal Session primitive;
- Audit / Recovery;
- state persistence;
- Host/Approval Broker integration;
- generic downstream transports;
- isolation primitives such as worktree/session allocation.

Core MUST NOT contain MATLAB, Simulink, STM32CubeIDE, ST-Link, CANoe or named local-Agent behavior.

Removing every optional application/agent plugin MUST leave Core bootable and usable.

# Layer 2 — Plugin Framework

The Plugin Framework is the common extension substrate.

Plugin classes:

1. **Application Plugin**
   - MATLAB / Simulink
   - STM32CubeIDE / ST-Link
   - CANoe
   - future engineering applications

2. **Agent Provider Plugin**
   - adapters for local coding/engineering Agents;
   - each provider maps a concrete Agent implementation to the generic Agent Runtime contract.

All plugin types use the same Manifest / API-version / dependency / lifecycle / permission model.

A plugin may contribute:
- Capability descriptors;
- typed adapters;
- downstream definitions;
- verified assets;
- Agent providers.

A plugin MUST NOT grant itself additional Workspace, host or external authority.

Foundation V3 continues the V2 loading rule:
- no arbitrary remote plugin path;
- no directory scanning that executes unreviewed code;
- independently distributed plugins require authenticated packages or an isolated Plugin Host.

# Layer 3 — Agent Runtime

Agent Runtime is a generic Core service. Concrete local Agents are Provider Plugins.

## Contract

Target control surface:

```text
agent_list
agent_start
agent_task
agent_status
agent_output
agent_stop
agent_handoff
```

An Agent Session has at minimum:
- session_id;
- provider_id;
- workspace_id;
- isolated_work_root;
- task_id;
- lifecycle state;
- started_at;
- last_activity_at;
- capability/permission context;
- recovery state.

## Isolation

Writing Agents MUST NOT share the same mutable checkout by default.

For Git workspaces, the default model is:

```text
Workspace
  |
  +-- Agent A -> worktree/session A
  +-- Agent B -> worktree/session B
  +-- Agent C -> worktree/session C
```

The Orchestrator reconciles outputs after each Agent finishes.

Read-only Agents MAY share a Workspace when policy permits.

If an Agent executable has normal Windows-user authority, worktree separation prevents ordinary file collisions but
is not an OS security sandbox. Hard containment still requires a restricted account/container/VM/worker.

## Provider independence

Workflow definitions reference the generic Agent Runtime / Capability contract, not a concrete Agent executable.

Replacing one Agent Provider with another SHOULD NOT require changing a Skill unless the required capability contract
changes.

# Layer 4 — Verified Asset and Meta-Capability System

P05 should accumulate reusable engineering actions rather than regenerate implementation code for every task.

## Script Asset

An asset may be:
- MATLAB `.m`;
- PowerShell;
- Python;
- GDB script;
- CubeIDE CLI script;
- configuration/template data;
- other deterministic application automation material.

An asset is NOT automatically a Capability.

## Asset lifecycle

```text
DRAFT
  -> VERIFIED
  -> APPROVED / ACTIVE
  -> DEPRECATED
```

Only VERIFIED + authorized assets may back production Meta-Capabilities.

Each registered asset records:
- stable asset id;
- version;
- content hash;
- owning plugin;
- runtime type;
- dependency/software-version constraints;
- input schema;
- output schema;
- verification result;
- lifecycle state.

A changed script with a different hash is a new asset revision and must be re-verified.

## Meta-Capability

A Meta-Capability gives a stable semantic ID to a reusable action, independent of its implementation file.

Examples:

```text
matlab.run_model_check
matlab.export_signal_report
stm32.clean_build
stm32.flash_and_verify
stm32.capture_fault_context
```

A Meta-Capability can be backed by:
- a verified script asset;
- an Application Plugin adapter;
- an Agent Provider;
- a composed Core capability.

Callers reference Capability IDs, never asset filenames.

Input/output are schema-defined. Parameter variation must normally be expressed through schemas rather than by
rewriting scripts.

Every Meta-Capability executes through Core Policy / Runtime / Verify / Audit.

# Layer 5 — Skill / Workflow Engine

A Skill is an executable reusable workflow, not merely a Markdown prompt.

## Skill contract

Every Skill MUST declare:

- stable skill id;
- version;
- description;
- typed input schema;
- typed output schema;
- referenced Capability IDs;
- workflow graph/state machine;
- Definition of Done;
- stop conditions;
- retry policy;
- timeout/budget limits;
- approval points;
- recovery semantics.

A Skill MUST NOT bind directly to:
- a script filename;
- a MATLAB executable path;
- a concrete local Agent command;
- an implementation-specific MCP tool when an abstract Capability exists.

## Workflow primitives

Target primitives:

- sequence;
- condition;
- bounded loop;
- parallel branches;
- join;
- verify;
- human approval;
- retry;
- fallback;
- handoff;
- stop/fail/complete.

Every loop MUST be bounded by an explicit condition plus iteration/time/budget limit.

## Target control surface

```text
skill_list
skill_describe
skill_run
skill_status
skill_stop
skill_resume
```

Workflow state must be persisted sufficiently to classify an interrupted run after reconnect/restart.

# Layer 6 — Orchestrator

The Orchestrator is the generic coordination/control plane between ChatGPT and the lower execution layers.

ChatGPT remains the high-level reasoning/planning authority.

The Orchestrator provides deterministic machinery for:
- task decomposition state;
- Skill invocation;
- Agent assignment;
- parallel execution;
- dependency tracking;
- result collection;
- conflict detection;
- Handoff;
- reconcile/merge;
- retry/recovery;
- approval gates;
- task completion state.

The Orchestrator MUST NOT implement MATLAB/Git/STM32 business logic itself.

It references:
- Skills;
- Capabilities;
- Agent Runtime;
- Workspace isolation primitives.

## Conflict model

Multiple writing Agents use isolated work roots.

Reconciliation is explicit:

```text
agent result
   -> inspect diff/artifact
   -> verify
   -> detect conflicts
   -> reconcile / reject / request rework
   -> integrate into target workspace
```

No parallel Agent is allowed to silently overwrite another Agent's unreviewed changes.

# Unified authorization and execution path

Plugin, Agent, Skill and Orchestrator actions MUST converge on the Core authorization/execution path.

Conceptually:

```text
request
  -> resolve Workspace / Actor / Skill / Capability
  -> prepare
  -> authorize
  -> allocate isolation/session if required
  -> execute
  -> verify
  -> audit
  -> recover / handoff / complete
```

No extension layer may directly bypass Core Policy because it happens to run locally.

# Separation rules

## ARC-01 — Core generic only

Core contains no concrete application or concrete Agent implementation.

## ARC-02 — Unified Plugin Contract

Application and Agent Provider extensions use the Plugin Framework.

## ARC-03 — Agent Provider Contract

Concrete local Agents map to the generic Agent Runtime.

## ARC-04 — Skill references Capability

Skill definitions reference Capability IDs, not implementation names/files.

## ARC-05 — Bounded workflow

Skills define Input / Output / DoD / Stop / Retry / Timeout-Budget.

## ARC-06 — No policy bypass

Plugin, Agent, Skill and Orchestrator actions flow through Core authorization/execution.

## ARC-07 — Multi-Agent isolation

Concurrent writing Agents use independent worktree/session roots and explicit reconciliation.

## SK-01 — Workflow plus assets

A Skill may package/reference workflow definitions and verified script assets.

## SK-02 — Stable semantic capability

Script-backed actions expose stable Capability IDs.

## SK-03 — Verification gate

Unverified scripts do not become active Meta-Capabilities.

## SK-04 — Version/hash

Every active asset is versioned and content-hashed.

## SK-05 — Typed I/O

Capability and Skill inputs/outputs are schema-defined.

## SK-06 — Runtime path

Script-backed capabilities still use Policy / Runtime / Verify / Audit.

## SK-07 — Reuse first

The Orchestrator should select existing Meta-Capabilities before initiating new asset/capability development.

# Planned source structure

```text
src/
  core/                 # optional future namespace as existing generic modules converge
  workspace/
  capability/
  policy/
  runtime/
  audit/
  plugin/
  agent/
    types.ts
    registry.ts
    runtime.ts
    session.ts
  assets/
    types.ts
    registry.ts
    verification.ts
  skill/
    types.ts
    registry.ts
    runtime.ts
    state.ts
  orchestrator/
    task.ts
    runtime.ts
    handoff.ts
    reconcile.ts

plugins/
  matlab/
    plugin
    scripts/
  stm32/
    plugin
    scripts/
  agents/
    <provider>/

skills/
  <skill-id>/
    skill.yaml|json
    assets/
```

The current codebase may continue using `src/plugins/*` during migration. Physical directory layout must not be
confused with architectural layer ownership.

# Acceptance criteria for V3

1. Foundation V2 tests remain green.
2. Core boots with no Application or Agent Provider plugins.
3. Adding a new Application Plugin does not require Workspace/Security Core changes.
4. Multiple Agent Providers can coexist.
5. Writing Agent Sessions use isolated work roots.
6. `skill_list/describe/run/status/stop` operate through a generic Skill Runtime.
7. Skills reference Capability IDs only.
8. Asset Registry rejects hash/version/state violations.
9. Unverified script assets cannot execute as active Meta-Capabilities.
10. Agent/Plugin/Skill execution appears in the same Audit/Recovery model.
11. Agent/provider failure is recoverable, retryable or handoff-capable without crashing Core.
12. Workflow loops are bounded.
13. Parallel results cannot silently overwrite each other.
14. MATLAB/STM32 implementations live outside Core.
15. Existing verified Meta-Capabilities are preferred over generating new scripts.

# Implementation order

V3 SHOULD be implemented incrementally.

The first delivery slice is V3-A, defined normatively in `TARGET_ARCHITECTURE_V3A.md`:

1. immutable Execution Context;
2. generic Session Manager;
3. Process Driver abstraction with LocalPowerShellDriver as the reference implementation;
4. worktree/session-root Isolation Manager and reconciliation primitive;
5. Agent Runtime contract + one reference Agent Provider;
6. V3-A stabilization against the full Foundation V2 regression baseline.

Only after V3-A is stable should implementation proceed to:

7. Verified Asset Registry;
8. Meta-Capability binding;
9. Skill Contract / Registry / Runtime;
10. Orchestrator task + handoff + parallel/join;
11. MATLAB stable Meta-Capabilities;
12. STM32 plugin + Build/Flash/Debug Meta-Capabilities;
13. advanced multi-device / GUI / isolated Plugin Host as needed.

This ordering is intentional: Skills and Orchestrator must not encode assumptions from an unstable execution,
session, Workspace-context or isolation model.
