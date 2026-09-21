# ADR-0011 — P05 Core / Plugin Framework Boundary

Status: Accepted for Foundation V2; refined by ADR-0018 for Architecture V3
Date: 2026-09-20
V3 refinement: 2026-09-21

## Foundation V2 decision

P05 is split into three architectural layers:

1. P05 Core — generic remote engineering Agent primitives.
2. Plugin Framework — manifest, registry, lifecycle and Core integration.
3. Application Plugins — MATLAB, Simulink, STM32CubeIDE, CANoe and future application adapters.

Application-specific logic must not be added directly to the Core bootstrap, Workspace, Security, Runtime or Audit
modules.

## Plugin loading

Foundation V2 uses explicit source-level registration of built-in plugins.

Arbitrary filesystem plugin discovery or remote path loading is prohibited.

This is deliberately less dynamic than a generic plugin loader because an in-process plugin has the authority of the
P05 Windows account.

## Capability and policy

Plugin capabilities merge into the same CapabilityCatalog used by:

- Policy;
- Exposer;
- Execution Runtime;
- Audit.

Plugin capability names must be namespaced by plugin id.

Workspace activation is checked by a Core-owned wrapper before a plugin tool handler runs.

## Downstream MCP

Downstream MCP is a generic Core adapter.

Application plugins may contribute downstream definitions. Each definition records its owning plugin and a Workspace
binding. Downstream calls are refused when the owning plugin is not enabled for the active Workspace.

## Foundation V2 consequences

Positive:

- Core no longer knows MATLAB/CubeIDE-specific behavior;
- applications can evolve without repeatedly editing Core security/workspace logic;
- plugins share one permission/audit model;
- a failed optional plugin does not take down Core.

Tradeoff:

- built-in plugin upgrades currently require a P05 build/restart;
- true independently distributed plugins require a later authenticated or isolated package model.

## Architecture V3 refinement

ADR-0018 refines but does not reverse this boundary.

In V3:

- Plugin becomes package/distribution/ownership metadata;
- Component becomes the runtime composition unit;
- Fiber becomes one live Component instance;
- Context becomes the scoped service graph and registration-ownership mechanism;
- Trust/Durable Kernel remains the non-ordinary-hot-reloadable authority root.

The V2 rule "application logic stays outside Core security/workspace/runtime authority" remains valid.

The refinement solves a different problem: runtime ownership, dependency activation, cleanup and hot replacement.

V3 therefore interprets the old three layers as:

```text
Trust / Durable Kernel
        |
        v
Composition Kernel
        |
        v
Plugin Packages
   -> Components
      -> Fibers
```

A Component can be dynamically loaded only within the authority already granted by the Trust/Durable Kernel.

## References

- docs/architecture/TARGET_ARCHITECTURE_V3.md
- docs/architecture/CONTEXT-COMPONENT-RUNTIME.md
- docs/architecture/PLUGIN-FRAMEWORK.md
- docs/adr/ADR-0018-trust-kernel-context-component-runtime.md
