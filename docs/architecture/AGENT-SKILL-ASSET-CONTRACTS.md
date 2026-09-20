# Agent, Skill, Asset and Orchestrator Contracts

Status: target contracts for Architecture V3
Date: 2026-09-20

## One-line distinctions

- **Capability** — what can be done.
- **Plugin** — how optional capability/provider implementations enter P05.
- **Asset** — a versioned verified implementation artifact.
- **Agent** — an execution actor that can work on a task.
- **Skill** — a reusable bounded process over Capabilities.
- **Orchestrator** — coordination of Skills, Agents, dependencies and reconciliation.
- **Core Runtime** — authorization, execution, verification, audit and recovery substrate.

## Dependency direction

```text
Orchestrator
    -> Skill
        -> Capability
            -> Core / Plugin / Agent Provider / Verified Asset
                -> Core Runtime
```

Reverse dependencies are forbidden:
- Core does not import a Skill;
- Core does not import MATLAB/STM32;
- a Skill does not reach directly into an implementation script;
- an Agent Provider does not grant itself authority;
- an Asset does not decide policy.

## Capability portability

A workflow should survive implementation replacement.

Example:

```text
Skill: vehicle-software-release
  -> capability: stm32.clean_build
```

Today the capability may use CubeIDE CLI. Later it could use another build adapter without changing the Skill.

## Agent semantics

Agents are not Capabilities.

An Agent consumes tasks and uses authorized Capabilities / workspace access. It has session identity and lifecycle.

Provider-specific prompt/CLI details belong in an Agent Provider Plugin.

## Skill semantics

A Skill is not an Agent prompt.

A Skill is a persisted, inspectable workflow contract with:
- schema input/output;
- explicit Capability dependencies;
- state transitions;
- DoD;
- stop/retry/budget constraints.

Natural-language guidance may be an asset of a Skill, but cannot be its only executable definition.

## Asset promotion

Ad-hoc generated script:

```text
temporary task artifact
   -> test/verification
   -> DRAFT registry entry
   -> VERIFIED
   -> human/project approval when required
   -> ACTIVE Meta-Capability backing
```

Failures or software-version incompatibility may move the asset to DEPRECATED.

## Reuse policy

Before generating a new script or asking an Agent to reinvent an action:

1. search Capability Catalog;
2. search active plugin capabilities;
3. search Verified Asset Registry / Meta-Capabilities;
4. search Skills;
5. only then create a new implementation candidate.

This is how P05 accumulates engineering leverage over time.

## Multi-Agent rule

Parallel writing work is isolated first, reconciled second.

The minimum integration record should identify:
- originating agent session;
- task/skill run;
- source worktree;
- changed files/commits/artifacts;
- verification result;
- target workspace;
- conflict/reconcile result.

## Policy rule

The architectural presence of an Agent, Skill or Asset never increases authority.

Authority is derived from the same Core policy inputs:
- profile;
- workspace;
- capability;
- approval/broker state;
- isolation context;
- plugin/workspace activation.

## Failure rule

A failure is local to the smallest responsible layer where possible:

- Asset execution failure -> capability execution failed;
- Agent Provider failure -> Agent Session failed/recoverable;
- Plugin start failure -> plugin failed, Core remains up;
- Skill step failure -> workflow retry/fallback/handoff/failed;
- Orchestrator branch failure -> branch state, not silent global corruption.

All failure paths must produce Audit/Recovery state.
