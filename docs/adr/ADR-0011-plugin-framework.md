# ADR-0011 — P05 Core / Plugin Framework Boundary

Status: Accepted
Date: 2026-09-20

## Decision

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

Application plugins may contribute downstream definitions. Each definition records its owning plugin and a workspace
binding. Downstream calls are refused when the owning plugin is not enabled for the active workspace.

## Consequences

Positive:
- Core no longer knows MATLAB/CubeIDE-specific behavior;
- applications can evolve without repeatedly editing Core security/workspace logic;
- plugins share one permission/audit model;
- a failed optional plugin does not take down Core.

Tradeoff:
- built-in plugin upgrades currently require a P05 build/restart;
- true independently distributed plugins require a later authenticated or isolated package model.