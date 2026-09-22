# P05 V3 Core Routing Design

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Objective

Routing lets one stable Core MCP endpoint expose both fixed Core recovery tools and optional capabilities without importing domain implementations into Core.

Core routes; Optional Runtime executes.

## 2. Route classes

### Core routes

Built-in, versioned recovery/control tools implemented by Core.

These remain available independent of Optional Runtime.

### Optional routes

Descriptors contributed by Optional Runtime over an internal bridge.

Core stores only the routing metadata required to expose and forward the call.

## 3. Route identity

Every optional route MUST have:

- globally unique tool/capability name;
- contract/schema version;
- provider/runtime instance identity;
- generation/revision;
- input/output schema metadata;
- health/availability state.

Domain implementation objects never cross into Core.

## 4. Namespace and conflict rules

ROUTE-01: Core built-in names are reserved and cannot be shadowed.

ROUTE-02: Optional route names must be unique in the active exported tool registry.

ROUTE-03: Duplicate/conflicting registrations reject the conflicting optional contribution; Core remains ready.

ROUTE-04: Unknown or incompatible schemas fail registration, not Core boot.

ROUTE-05: Removal of an optional route never removes Core recovery routes.

## 5. Registration lifecycle

Optional Runtime attaches using a registration handshake:

```text
runtime instance starts
  -> negotiate bridge API version
  -> publish route snapshot
  -> Core validates metadata
  -> accepted routes become ACTIVE
```

Registration uses a runtime-instance generation. When that instance disappears, all routes owned by that generation become unavailable together.

Stale registrations MUST NOT survive runtime replacement.

## 6. Invocation routing

For each optional invocation Core MUST:

1. resolve one ACTIVE route;
2. pin route generation/provider identity for that invocation;
3. apply Core policy/authority checks that belong at the control-plane boundary;
4. forward the bounded request;
5. enforce timeout/cancellation/output limits;
6. return structured result/error;
7. record bounded diagnostic metadata.

If the provider disappears during execution, the result is an explicit provider/runtime unavailable or interrupted error.

## 7. Dynamic tool discovery

Core owns the AI-visible tool catalog.

When Optional Runtime contributions change, Core updates the exported catalog using protocol-supported list-change semantics where available.

If a client/transport cannot refresh the tool list dynamically, Core remains online and reports that client reconnection is required to observe the new optional catalog. This is a compatibility issue, not a Core failure.

## 8. Structured routing errors

Routing errors include at minimum:

- optional-runtime-unavailable;
- route-not-found;
- route-conflict;
- route-incompatible;
- provider-replaced;
- invocation-timeout;
- invocation-cancelled;
- output-limit;
- policy-denied.

Errors are explicit and must not be translated into generic Core offline state.

## 9. Routing security

Visibility of an optional route does not grant authority to execute it.

Core policy remains non-bypassable.

Optional Runtime cannot register a route that replaces Core security/recovery primitives.

## 10. Acceptance

1. Optional Runtime absent -> Core routes remain available.
2. Duplicate optional names -> conflicting contribution rejected only.
3. Runtime replacement -> old generation cannot receive new calls.
4. Provider disappears mid-call -> invocation fails explicitly; Core remains responsive.
5. Optional catalog refresh does not restart Core.

