# P05 Plugin Framework

Status: Foundation V2 implemented; Architecture V3 packaging model defined
Date: 2026-09-21
Related target:
- TARGET_ARCHITECTURE_V3.md
- CONTEXT-COMPONENT-RUNTIME.md
- ADR-0018-trust-kernel-context-component-runtime.md

## 1. Purpose

Foundation V2 introduced the Plugin Framework to keep application-specific behavior outside P05 Core.

Architecture V3 keeps that separation but refines the meaning of "Plugin".

In V3:

- **Plugin = package/distribution/ownership unit**
- **Component = runtime compositional unit**
- **Fiber = one live Component instance**

This prevents packaging concerns from becoming the lifecycle model for every dynamic service.

## 2. Foundation V2 baseline

Current implementation:

- `src/plugin/types.ts`
- `src/plugin/registry.ts`
- `src/plugin/runtime.ts`
- built-ins under `src/plugins/*`

V2 Plugin Runtime provides:

- manifest/API version;
- permissions;
- dependencies;
- capabilities;
- downstream contributions;
- Workspace activation;
- lifecycle isolation;
- no arbitrary remote path loader.

These contracts remain useful.

## 3. V3 packaging model

A target Plugin Package may contain:

```text
PluginPackage
  |
  +-- manifest
  +-- components/
  |    +-- application adapter
  |    +-- provider
  |    +-- optional UI/observer
  |
  +-- assets/
  +-- schemas/
  +-- migrations/
  +-- docs/
```

The package manifest owns:

- stable package id;
- package version;
- supported P05/Component API versions;
- publisher/owner metadata;
- trust/signature metadata where applicable;
- declared Components;
- package dependencies;
- requested permission classes;
- optional Assets/Skills metadata.

Package presence does not automatically activate every Component.

## 4. Component runtime

Each runtime contribution is a Component.

A Component declares:

- `requires` Service Keys;
- `provides` Service Keys;
- requested permissions;
- config schema;
- activation implementation.

Loading a Component creates a Fiber.

The Composition Kernel, not Plugin code, owns:

- dependency readiness;
- activation ordering;
- Fiber lifecycle;
- registration cleanup;
- retirement/drain;
- config reconciliation.

## 5. Security model

### 5.1 Current V2

Plugins are trusted reviewed code shipped with the P05 build.

There is no arbitrary remote plugin path loader.

Remote plugin tool calls remain subject to Core exposure, Policy, Execution Runtime and Audit.

### 5.2 V3

Plugin trust classes may include:

- `builtin-trusted`
- `installed-trusted`
- `out-of-process-isolated`

Trust class does not grant operation authority.

A Component may request permission but cannot self-authorize.

The Trust/Durable Kernel remains outside ordinary Component hot replacement.

### 5.3 Third-party packages

Independently distributed packages require one of:

- authenticated/reviewed package flow;
- signed package verification;
- out-of-process isolated Plugin Host.

No remote caller may provide an arbitrary executable file path and cause in-process loading.

## 6. Runtime effects

Dynamic Plugin/Component registrations are Fiber-owned E1 Effects.

Examples:

- Service provision;
- Capability Binding;
- Agent Provider registration;
- event listener;
- downstream definition registration;
- UI observer registration.

On Fiber retirement/disposal these contributions disappear structurally.

External engineering actions are not Plugin cleanup effects.

For example:

- file mutation;
- Git commit/push;
- firmware flash;
- external application mutation;

must continue through Capability/Policy/Invocation/Audit semantics.

## 7. Dependencies

V2 manifest dependencies evolve into typed Component service requirements.

Preferred:

```ts
requires: [
  { key: "p05.capabilities", versionRange: "^3" },
  { key: "app.matlab", versionRange: "^1" }
]
```

rather than manual startup order or ad-hoc availability polling.

Behavior:

- missing required Service -> Fiber remains PENDING;
- requirements become ready -> Fiber activates;
- required provider retires -> dependent enters controlled retirement;
- provider returns -> dependent may reactivate.

## 8. Workspace activation

Workspace Component policy remains separate from host package installation.

Example:

```json
{
  "id": "vehicle",
  "root": "D:\\Project_Git\\P02_Vmodel",
  "kind": "git-project",
  "plugins": ["matlab", "stm32"]
}
```

V3 interpretation:

1. package is installed/available;
2. Workspace policy permits package/Components;
3. Workspace Context derives the appropriate Component graph;
4. Policy still determines what operations are authorized.

An empty Workspace package allowlist can disable optional application packages.

## 9. Application Plugin

Application package may provide Components such as:

```text
matlab package
  |
  +-- matlab-service Component
  +-- downstream-mcp Component
  +-- capability-bindings Component
  +-- optional diagnostics Component
  +-- verified Assets
```

P05 Core contains no MATLAB-specific behavior.

## 10. Agent Provider Plugin

Agent Provider package may provide:

- provider registration Component;
- terminal/transport adapter Component;
- prompt/tool contributions;
- provider-specific Assets.

Provider registration is Fiber-owned.
Agent Session state is not.

A provider Fiber can retire while durable Agent Session records remain recoverable.

## 11. Worker Provider Plugin

Future Worker packages may contribute:

- trusted local Worker;
- constrained-host Worker;
- Sandbox/VM Worker;
- remote-node Worker.

Worker availability is composition state.
Authorization to use a Worker remains Policy state.

## 12. Plugin lifecycle vs Fiber lifecycle

V2 Plugin lifecycle:

```text
disabled -> ready -> running -> failed/stopped
```

V3 runtime lifecycle moves to Fiber:

```text
DECLARED
  -> PENDING
  -> ACTIVATING
  -> ACTIVE
  -> RETIRING
  -> DRAINING
  -> DISPOSING
  -> DISPOSED

ACTIVATING/ACTIVE/... -> FAILED
```

Package installation state and Fiber runtime state must not be conflated.

## 13. Declarative composition

Target deployments use Composition Profiles/Bundles.

Example:

```yaml
bundles:
  - p05/base
  - apps/matlab
  - agents/coding

components:
  app.matlab:
    enabled: true
```

The Config Reconciler computes the desired live Component graph.

Composition configuration cannot enable a higher Permission/Tool Profile.

## 14. Hot replacement

Component replacement is allowed only for eligible runtime units.

Flow:

```text
candidate package/component
  -> verify
  -> Shadow Context
  -> activate candidate Fiber
  -> redirect new resolution
  -> retire/drain old Fiber
  -> dispose old Fiber
```

Policy/Approval/State-integrity trust-root code does not use ordinary Component HMR.

## 15. MATLAB reference package

Current P05 uses:

- `src/plugins/matlab/plugin.ts`
- `src/plugins/matlab/skills.ts`

The current MATLAB plugin is migrated to Plugin API v1 and:
- discovers the local MathWorks Agentic Toolkit by default;
- resolves the MathWorks-managed MATLAB MCP executable;
- adds the Simulink tools extension when present;
- binds downstream MATLAB execution to the active P05 Workspace;
- guards explicit model/path arguments against the active Workspace;
- exposes MathWorks MATLAB/Simulink `SKILL.md` assets through read-only
  `matlab.skill_list` and `matlab.skill_read` capabilities.

Those MathWorks `SKILL.md` files are plugin-provided guidance assets. They are not
P05 V3 executable Skills and do not implement `skill_run`. Promotion into the generic
Skill Runtime requires the normal typed I/O, Capability dependency, state/DoD,
stop/retry and budget contracts.

Target V3 should migrate the package's runtime responsibilities into Components while preserving:

- Workspace binding;
- package ownership;
- downstream ownership;
- Capability contribution ownership;
- failure isolation.

The migration is complete for the current v0.1 Plugin API surface: MATLAB uses declarative tools, Public Plugin API downstream declarations, PluginContext Workspace access, and no legacy `registerTools()` hook. Typed config and first-class Skill/Asset contribution remain future API work.

## 16. Required invariants

- Plugin package never self-authorizes.
- Component activation depends on declared services rather than manual order.
- Every dynamic registration has one Fiber owner.
- Fiber disposal removes all E1 contributions.
- Package install state, Component desired state and Fiber live state are separate.
- Workspace package policy is not host security isolation.
- Provider hot replacement respects durable Run drain/recovery.
- Trust Kernel is not an ordinary Plugin package target for self-HMR.
