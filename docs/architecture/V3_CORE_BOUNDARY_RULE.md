# P05 V3 Core Boundary Rule

Status: Frozen architecture boundary
Branch: v3
Authority: V3 Core admission baseline

## 1. Core definition

P05 Core is the stable control plane between ChatGPT/AI and the local host.

Core is neither a pure proxy nor a business-function container.

Core exists to keep the host connected, route requests, observe system state, supervise optional runtimes, recover failures, and enforce security boundaries.

## 2. The six permanent Core responsibilities

### C1 ? Connection

Core owns the stable MCP endpoint and the lifecycle required to keep AI connected to the host.

### C2 ? Routing

Core resolves where an optional capability lives and routes calls across a stable boundary.

Routing does not mean implementing the domain capability.

### C3 ? Health

Core reports its own state and the availability of optional runtimes, plugins and downstream connections.

### C4 ? Supervision

Core may start, stop, restart, disable and isolate P05-owned optional runtimes.

### C5 ? Recovery

Core keeps the minimum local repair surface required to restore the system:

- bounded file read/write/patch;
- local Git inspect/stage/commit/safe branch operations;
- configuration repair;
- diagnostics;
- controlled break-glass shell;
- runtime restart.

### C6 ? Security

Core owns the non-bypassable authority boundary:

- Workspace scope;
- path/sensitive-file enforcement;
- Policy;
- Approval;
- fail-closed behavior;
- audit/recovery metadata needed for safe control.

No optional subsystem may replace or bypass these controls.

## 3. Core admission rule

A new capability is rejected from Core by default.

It may enter Core only when all of the following are true:

1. Without it, ChatGPT cannot reliably remain connected, diagnose P05, repair P05, supervise P05, or enforce P05 authority.
2. The capability is domain-neutral and useful even when all business plugins are removed.
3. Its failure can be isolated without creating a new mandatory business dependency.
4. It has a smaller stable contract than placing equivalent domain logic in Core.
5. It does not require Core to understand MATLAB, STM32, Agent, Skill, Workflow, compiler, application or project-specific semantics.

If any condition fails, the capability belongs outside Core.

## 4. Explicit exclusion rule

The following are outside Core by default:

- MATLAB/Simulink logic;
- STM32/firmware logic;
- build/compiler integrations;
- Agent providers;
- Skill runtime;
- Workflow/Orchestrator logic;
- application automation;
- project-specific tools;
- model-specific assets/prompts;
- arbitrary downstream MCP execution;
- release/publish/push operations;
- optional UI.

Core may route to, supervise, diagnose or repair these systems, but MUST NOT absorb their business logic.

## 5. Dependency direction

Allowed:

```text
ChatGPT
   |
   v
P05 Core
   |
   +--> Optional Runtime
          +--> Plugin
          +--> Downstream MCP
          +--> Agent
          +--> MATLAB / STM32 / other domains
```

Forbidden:

```text
Core --> domain implementation required to boot
Core --> plugin required to expose recovery tools
Core --> downstream MCP required for readiness
Plugin --> bypass Core Policy/Approval
```

## 6. Size-control rule

Core growth is treated as architectural debt unless justified by the Core admission rule.

Convenience is not sufficient justification.

A feature being broadly useful is not sufficient justification.

A feature being used by many plugins is not sufficient justification; shared optional services may still live outside Core behind a stable contract.

## 7. Stability rule

Core public recovery contracts should change rarely.

Plugin/domain contracts may evolve faster.

The architecture therefore optimizes Core for:

- small dependency graph;
- predictable boot;
- backward-compatible recovery surface;
- low configuration sensitivity;
- fault isolation.

## 8. Final boundary statement

The frozen V3 boundary is:

> **Core = Connection + Routing + Health + Supervision + Recovery + Security.**

Everything else is optional unless it passes the Core admission rule.

This boundary is normative for subsequent V3 implementation.

