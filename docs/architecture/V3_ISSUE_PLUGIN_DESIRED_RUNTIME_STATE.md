# V3 Architecture Issue: Per-Slot Plugin Desired State and Runtime Lifecycle

Status: OPEN
Origin: V2 observed limitation
Scope: V3 Plugin / Component lifecycle
Decision: NOT YET DECIDED

## 1. Problem

P05 V2 does not expose independent per-plugin lifecycle control.

Current behavior is configuration-driven:

- plugin enabled state is read from configuration;
- Runtime startup constructs PluginRegistry and PluginRuntime;
- enabled plugins are started by PluginRuntime.startAll();
- Runtime termination stops plugins through PluginRuntime.stopAll();
- plugin_list exposes current plugin information.

There are no dedicated control operations equivalent to:

- plugin_start;
- plugin_stop;
- plugin_enable;
- plugin_disable.

Therefore, changing whether a plugin participates in one Runtime normally requires configuration change plus Runtime restart.

## 2. Current V2 startup model

Representative flow:

    Runtime A/B starts
      -> read environment/configuration
      -> construct PluginRegistry
      -> construct PluginRuntime
      -> startAll()
      -> enabled plugins become running

Runtime termination:

    Runtime termination
      -> PluginRuntime.stopAll()

The current model is valid for V2 and should not be replaced merely to add hot-plug behavior.

## 3. Multi-slot configuration limitation

Runtime A and Runtime B currently consume the same general environment/configuration source for plugin enablement.

Therefore a setting such as:

    MATLAB_MCP_ENABLED=true

naturally applies to both Runtime slots unless additional slot-specific configuration is introduced.

This makes it difficult to express:

    Runtime A -> MATLAB desired enabled
    Runtime B -> MATLAB desired disabled

while preserving both Runtime slots online.

This is separate from, but related to, shared external resource coordination.

## 4. Required conceptual separation

V3 should distinguish at least three concepts:

### Plugin Availability

Whether the Plugin Package/implementation exists and is loadable on the Host.

Example:

    matlab available = true

### Desired State

Whether a specific Runtime/Slot/Workspace intends the plugin to be active.

Example:

    Slot A / MATLAB desired = enabled
    Slot B / MATLAB desired = disabled

### Live Runtime State

What is actually true now.

Candidate states may include:

    stopped
    starting
    running
    stopping
    failed
    unavailable

The exact state machine is not decided by this issue record.

## 5. Why Desired State and Live State must differ

Configuration intent and runtime reality are not the same.

Examples:

    desired = enabled
    live = failed

    desired = disabled
    live = stopped

    desired = enabled
    live = starting

V3 should not overload one boolean enabled flag to mean installation, configuration intent and current process/plugin state simultaneously.

## 6. Scope question

V3 must explicitly decide the scope at which Desired State is defined.

Candidate scopes include:

- Host default;
- Runtime/Slot;
- Workspace;
- Slot + Workspace binding;
- project/profile.

The V2 A/B model requires at minimum that two Runtime slots can hold independent desired state where needed.

The exact precedence model is OPEN.

## 7. Control semantics

Future control operations may conceptually include:

    plugin_enable(pluginId, scope)
    plugin_disable(pluginId, scope)
    plugin_start(pluginId, slot)
    plugin_stop(pluginId, slot)
    plugin_status(pluginId, slot)

However, V3 must decide whether these should be public MCP tools, internal reconciliation commands, or both.

Important distinction:

- enable/disable changes desired configuration state;
- start/stop changes current runtime state;
- reconciliation determines how live state converges toward desired state.

These concepts must not be silently merged.

## 8. Reconciliation question

A future reconciler may conceptually enforce:

    desired = enabled + available = true
      -> live should converge toward running

    desired = disabled
      -> live should converge toward stopped

But V3 must define:

- retry policy;
- backoff;
- failure state;
- crash-loop behavior;
- dependency ordering;
- whether manual stop overrides desired enabled state;
- whether desired state persists across Runtime restart;
- what happens when Workspace binding changes.

This issue does not yet choose the reconciler implementation.

## 9. Interaction with A/B Runtime slots

V3 MUST preserve the V2 capability for Runtime A and Runtime B to operate concurrently on different Workspaces.

Therefore the plugin lifecycle model must allow, where policy/configuration permits:

    Slot A:
      plugin X desired = enabled
      plugin X live = running

    Slot B:
      plugin X desired = disabled
      plugin X live = stopped

Independent per-slot desired/live state must not require collapsing A/B into one Runtime.

## 10. Interaction with Shared Resource Coordination

This issue is related to but distinct from:

    V3_ISSUE_MULTI_RUNTIME_SHARED_RESOURCE_COORDINATION.md

Plugin desired/live state answers:

    Should this plugin instance be active in this Runtime?

Shared Resource Coordination answers:

    Can this active plugin instance use the underlying external resource right now?

Therefore:

    Plugin Enabled/Running != Resource Ownership/Availability

Example:

    Slot A MATLAB plugin running
    Slot B MATLAB plugin running

may still require serialized/exclusive coordination over one shared MATLAB resource.

Conversely:

    Slot B MATLAB plugin disabled

may avoid contention, but disabling a plugin is not a substitute for a general resource coordination model.

## 11. Persistence questions

V3 should decide which state survives restart.

Likely categories to evaluate:

- package availability: discovered from installation;
- desired state: durable configuration;
- live state: ephemeral runtime state;
- failure history: bounded diagnostic state.

Exact persistence ownership and schema are not decided here.

## 12. Security and authority

Changing plugin desired state may change the set of capabilities exposed by a Runtime.

Therefore:

- plugin enablement must not bypass Policy;
- plugin start must not grant new authority by itself;
- capability exposure after start must still obey Core/Workspace policy;
- one Slot must not silently mutate another Slot''s desired state unless explicitly authorized.

## 13. V2 decision

Do not add a V2 hot-plug lifecycle API solely to address this issue.

For V2, the accepted operational pattern remains:

    change plugin enabled configuration
      -> restart the corresponding Runtime
      -> verify with plugin_list

Stopping an entire Runtime stops all plugins in that Runtime.

## 14. V3 design questions

V3 architecture must answer:

1. What is the canonical Plugin/Component Desired State model?
2. What scopes can own desired state?
3. How is slot-specific configuration represented?
4. Is desired state durable?
5. What is the authoritative live-state machine?
6. Where does reconciliation run?
7. How do enable/disable differ from start/stop?
8. How are failures/backoff/crash-loop represented?
9. How does Workspace switching affect desired state?
10. How do route exposure and removal follow live state?
11. How does this interact with plugin dependencies?
12. How does this interact with shared external Resource coordination?
13. Which lifecycle operations require approval?

## 15. Current decision state

OPEN.

The problem is recorded as a V3 design input.

No decision has yet been made about:

- exact desired-state scope;
- exact lifecycle state machine;
- public plugin control tools;
- reconciler placement;
- configuration storage;
- hot-plug guarantees.

The only fixed requirement is that V3 preserve the V2 multi-slot model while allowing Plugin Package availability, desired state and live runtime state to be represented separately.

