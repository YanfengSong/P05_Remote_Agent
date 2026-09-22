# P05 V3 Core Instance Model

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Evolution rule

V3 is an upgrade of the working V2 architecture, not a replacement of it.

Existing V2 behavior that is already correct and useful is inherited by default.
V3 changes an existing mechanism only when a concrete stability, coupling, safety or extensibility problem requires it.

## 2. Existing V2 capability to preserve

V2 already supports multiple independent Runtime slots such as A and B.

Each slot can:

- maintain its own state directory;
- bind to its own active Workspace;
- expose its own MCP connection;
- restart independently;
- operate concurrently with another slot.

The purpose of A/B is concurrent work on different Workspaces, not connection redundancy.

V3 MUST preserve this behavior.

## 3. V3 terminology

V3 formalizes the existing pattern as:

- **Host** ? one physical/OS machine running P05.
- **Core Instance** ? one running P05 Core process.
- **Slot / Channel** ? one stable logical operating lane such as A or B.
- **Workspace Binding** ? the Workspace currently selected by that Slot.
- **Instance Generation** ? one concrete process generation of a Core Instance.

One Host may run multiple Core Instances concurrently.

## 4. Target topology

```text
P05 Host
  |
  +-- Host Identity
  |
  +-- Slot A / Core Instance A
  |     +-- Workspace A binding
  |     +-- Core recovery tools
  |     +-- Optional Runtime A
  |
  +-- Slot B / Core Instance B
  |     +-- Workspace B binding
  |     +-- Core recovery tools
  |     +-- Optional Runtime B
  |
  +-- future Slot C / ...
```

V3 does not require collapsing A/B into one process.

## 5. Isolation rule

Each Core Instance owns its own mutable session/runtime state.

A Workspace switch in Slot A MUST NOT alter Slot B.

An invocation captures its Slot/Workspace binding before execution and MUST NOT be silently retargeted by a later switch in the same or another Slot.

The existing V2 per-slot process/state separation is a valid isolation mechanism and may be retained.

## 6. Host identity vs instance identity

V2 currently stores `device.json` under the per-slot `P05_STATE_DIR`.
That can make A and B on the same physical host appear as different devices.

V3 should separate:

```text
hostId          stable identity of the physical P05 host
slotId          stable logical lane: A / B / ...
coreInstanceId  identity of the current Core process generation
startedAt       process generation timestamp
workspaceId     slot-local current binding
```

All slots on the same machine SHOULD report the same `hostId`.

Each running Core process has its own `coreInstanceId` or generation identity.

## 7. State ownership

### Shared host state

Only state that is truly machine-level may be shared, for example:

- host identity;
- provisioned host broker metadata;
- installed Core known-good version metadata;
- host-level deployment metadata.

### Per-slot state

Remain isolated:

- active Workspace binding;
- audit/recovery history where slot-specific;
- connection state;
- Optional Runtime state;
- route generation;
- slot diagnostics.

Sharing mutable per-slot state is forbidden unless a later explicit coordination contract requires it.

## 8. Optional Runtime ownership

The default V3 model is one Optional Runtime attachment per Core Instance.

This preserves Workspace isolation and limits blast radius.

A future shared Optional Runtime is allowed only if it can prove equivalent Workspace/authority isolation and does not create a mandatory cross-slot dependency.

## 9. Host-level actions

Host-level actions such as Core installation/upgrade or provisioned restart brokers are shared infrastructure.

A Slot may request a host-level action only through a narrow Core/host contract with explicit ownership and policy.

One Slot must not be able to impersonate or mutate another Slot''s state.

## 10. Acceptance

1. A and B can connect concurrently.
2. A and B can bind different Workspaces concurrently.
3. Switching A does not change B.
4. Restarting A does not restart B unless an explicit host-level operation requires it.
5. Both slots report the same Host identity.
6. Each Core process reports a distinct instance generation.
7. Optional Runtime failure in A does not take B offline.

