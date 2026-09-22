# V3 Architecture Issue: Multi-Runtime Shared Resource Coordination

Status: OPEN
Origin: V2 observed limitation
Scope: V3 platform architecture
Decision: NOT YET DECIDED

## 1. Problem

P05 V2 already supports multiple independent Runtime slots such as A and B.

Each Runtime owns its own PluginRegistry, PluginRuntime, plugin lifecycle state, MCP exposure, Workspace context and downstream connections.

This works for stateless plugins and Runtime-local resources.

The problem appears when multiple Runtime-local plugin instances actually control the same external resource, such as MATLAB/Simulink state, serial ports, CAN adapters, ST-Link/debug probes, firmware programmers, external application sessions, shared simulators, or exclusive license resources.

Central mismatch:

    Plugin instance scope != external resource scope

Runtime A and Runtime B may each load an independent plugin instance while both ultimately target one shared Host resource.

## 2. Current V2 limitation

V2 plugin state is Runtime-local.

A plugin can report ready/running/failed/stopped, but that does not answer:

- whether the underlying external resource is already in use;
- which Runtime currently owns it;
- whether concurrent use is safe;
- whether another Runtime should wait or fail;
- when ownership is released;
- how ownership is recovered after a Runtime crash.

Runtime A does not have a Host-global view of resources owned by Runtime B, and vice versa.

A process-local mutex cannot solve this because A and B are separate processes.

## 3. Required conceptual separation

V3 must keep these lifecycle objects distinct:

    Plugin Package
    Runtime Plugin / Component Instance
    External Resource

Multiple Runtime plugin instances may legitimately exist while only one external resource exists.

Therefore external resources require their own identity, availability and ownership model.

## 4. Resource scope questions

V3 must decide how resource scope is represented.

Initial candidate scopes:

- runtime;
- workspace;
- host.

Potential future scopes may include user, device, remote-node or cluster.

The exact scope model is not decided by this issue record.

## 5. Concurrency questions

Different resources may require different access semantics.

Initial candidate modes:

- parallel;
- serialized;
- exclusive.

Parallel permits concurrent use.
Serialized permits multiple callers but only one operation at a time.
Exclusive gives one owner control for a longer logical session.

Serialized call access and exclusive session ownership are different requirements.

## 6. Ownership and lease questions

V3 needs a cross-Runtime coordination primitive or equivalent mechanism.

Conceptual operations may include:

    acquire(resourceKey)
    renew(lease)
    release(resourceKey)
    query(resourceKey)

The architecture must define:

- lease owner identity;
- Runtime/Slot generation;
- timeout and renewal;
- stale-owner detection;
- crash recovery;
- queue ordering;
- cancellation;
- safe automatic reclaim;
- cases requiring human recovery.

If Runtime A acquires a resource and crashes, the resource must not remain permanently locked. But unsafe interrupted operations must also not be blindly reassigned.

## 7. Resource identity

Resources need stable logical identities independent of plugin instance identity.

Examples:

    matlab.session.default
    serial.COM3
    can.adapter.0
    stlink.serial-123456
    simulator.vehicle-project

Resource identity may depend on resource type, physical device identity, Workspace, Host and configuration.

It must not be inferred solely from the plugin instance that exposes the capability.

## 8. Authorization is separate from availability

Workspace/Capability authorization answers:

    May this caller use the resource?

Resource coordination answers:

    Can this caller use the resource right now?

Therefore:

    Authorization != Availability

Acquiring a resource must never grant authority that Policy did not already permit.

## 9. Crash and recovery questions

The V3 design must define behavior for at least:

- Runtime crash;
- plugin crash;
- downstream process crash;
- Host power-cycle/startup;
- network interruption;
- lease expiry;
- partial operation failure.

Different resource classes may require different recovery rules.

A stale MATLAB ownership record may be reclaimable automatically, while an interrupted firmware flashing operation may require manual verification before reuse.

## 10. Observability requirement

Operators and Runtime slots should eventually be able to inspect shared resource state, including:

- resource identity;
- scope;
- concurrency mode;
- current state;
- owner Runtime/Slot;
- owner Workspace;
- acquisition time;
- wait queue where applicable.

This becomes important when multiple ChatGPT channels operate the same Host concurrently.

## 11. Relationship to existing V3 documents

Existing V3 architecture already contains an earlier Resource Lease Manager concept with shared/exclusive/bounded resource semantics.

That concept is relevant, but this V2 issue is NOT considered resolved by its existence.

The remaining architecture questions include:

1. What is the canonical Resource abstraction?
2. Which resource scopes are supported?
3. Which concurrency modes are supported?
4. Where does cross-Runtime coordination live?
5. How do independent Core/Runtime slots communicate with it?
6. How are stable resource keys generated?
7. What owns a lease?
8. How are stale leases detected and reclaimed?
9. What survives Runtime restart or Host restart?
10. Which interrupted operations require human recovery?
11. How is resource state exposed to diagnostics?
12. How does this interact with Workspace changes and Plugin/Component lifecycle?

## 12. V2 decision

Do not introduce a new cross-Runtime Resource Broker into Plugin API v1 solely to solve this issue.

V2 remains valid for:

- stateless plugins;
- Runtime-local resources;
- resources whose downstream implementation already safely coordinates concurrency.

Shared stateful resources require caution until V3 defines the platform-level coordination model.

## 13. V3 constraint

V3 is an upgrade of V2 and MUST preserve the existing A/B concurrent Workspace capability.

The solution must coordinate shared external resources across independent Runtime/Core slots without collapsing those slots or converting their Workspace-local state into one global active Workspace.

## 14. Current decision state

OPEN.

No decision has yet been made that the Resource Coordinator belongs in Core, a Host-level service, Optional Runtime, a dedicated durable coordination service, or another mechanism.

Placement must be decided from failure isolation, authority, durability and multi-Runtime requirements rather than convenience.

