# P05 V3 Core Architecture Review

Status: review completed with required corrections
Branch: v3

## 1. Review principle

V3 is an evolutionary upgrade of V2.

The review therefore distinguishes:

- **Inherited** ? V2 already implements the capability; preserve it.
- **Harden** ? V2 works, but architecture/failure behavior needs strengthening.
- **Missing** ? V2 does not yet provide the required Core guarantee.
- **Out of scope** ? do not redesign as part of Core.

## 2. Inherited V2 capabilities

The following are NOT V3 gaps:

### Multi-Workspace parallel operation

V2 already provides Runtime A/B as independent operating channels with separate state and Workspace binding.

Decision: preserve this model and formalize it as multiple Core Instances/Slots.

### Workspace isolation

Each V2 process owns its own `WorkspaceManager.#currentId`.

Decision: retain slot-local Workspace state; do not replace it with one device-global active Workspace.

### Independent restart

V2 runtime scripts can start/stop/restart A and B independently.

Decision: keep per-slot lifecycle semantics.

### Basic recovery tools

V2 already provides device, Workspace, filesystem, Git, audit/recovery, restart and trusted-shell capabilities.

Decision: reuse and harden; do not rewrite without cause.

### External tunnel/runtime scripts

V2 already keeps tunnel/deployment mechanics outside domain tools.

Decision: keep external infrastructure separable from Core business logic.

## 3. Corrections to previous V3 design

### R-01 ? Do not collapse A/B into one Core

Previous review reasoning incorrectly treated A/B as redundant connections.

Correct model:

```text
one Host
  -> multiple Core Instances / Slots
  -> each Slot has independent Workspace binding
```

A single-process multi-channel implementation is not required for V3.

### R-02 ? Single-active rule is per Slot, not per Host

The previous lifecycle text saying one device may have only one active Core authority conflicts with V2 A/B.

Correct rule:

> One Slot has at most one active Core generation. One Host may have multiple active Slots.

### R-03 ? Connection is not synonymous with Slot redundancy

A/B are work channels.

Remote reconnection/backoff is a transport concern within each Slot.

### R-04 ? V3 architecture must preserve deployed behavior first

Internal refactoring is acceptable only when the externally useful V2 behavior remains available or is deliberately migrated.

## 4. Actual remaining Core gaps

### G-01 ? Host identity and Core-instance identity are conflated

Current V2 places `device.json` inside each slot's state directory.

Observed result on the same host:

- Runtime A and Runtime B report the same hostname;
- they report different `deviceId` values.

V3 needs one shared Host identity plus separate Slot/Core-instance identity.

### G-02 ? Optional plugin/runtime code is still in the Core process

V2 catches plugin start failures, but import-time failure, event-loop blockage, native crash or memory failure can still affect the Core process.

V3 should harden the fault boundary while preserving the current plugin-facing behavior.

### G-03 ? Degraded/Recovery/Locked startup is not implemented

Several V2 state/config failures can still abort startup.

V3 needs the already-designed mode semantics so the recovery plane survives safe-to-degrade failures.

### G-04 ? Core upgrade has restart but no known-good transactional rollback

V2 can rebuild/restart itself, but restart is not equivalent to safe upgrade.

V3 still needs candidate validation and last-known-good rollback owned by external host infrastructure.

### G-05 ? Core-wide resource protection is incomplete

V2 has individual time/output limits, but no explicit global guarantee that optional work cannot starve Core recovery/status capacity.

V3 needs bounded concurrency/backpressure/priority protection.

### G-06 ? Core status model is incomplete

V2 has `ping`, device info, plugin/downstream status and activity, but not one authoritative `core_status` combining:

- Core readiness;
- mode;
- Slot identity;
- Host identity;
- connection state;
- Optional Runtime state;
- quarantined state;
- compatibility state.

### G-07 ? Cross-instance host-level coordination needs a narrow contract

Because A/B can run concurrently, shared host operations must have explicit ownership.

Examples:

- Core upgrade;
- host broker;
- machine-level configuration;
- shared installation metadata.

This does NOT require merging A/B. It requires preventing two Slots from racing on shared host state.

## 5. Existing design that remains valid

The following V3 designs remain useful after the correction:

- Core boundary: Connection + Routing + Health + Supervision + Recovery + Security.
- Optional failure must not kill Core.
- Recovery/Degraded/Locked modes.
- route conflicts must not affect Core routes.
- bounded restart/crash-loop policy.
- Core upgrade rollback.
- bounded resource usage.

Their implementation must be adapted to the multi-instance V2 deployment model.

## 6. Revised target

```text
                       P05 Host
                          |
              +-----------+-----------+
              |                       |
        Core Slot A               Core Slot B
        Workspace A               Workspace B
              |                       |
      Optional Runtime A       Optional Runtime B
```

Shared below/around the slots:

- Host Identity;
- external host supervisor/updater;
- narrow host brokers;
- installation metadata.

Slot-local:

- Workspace binding;
- MCP connection;
- audit/runtime state;
- Optional Runtime;
- route state.

## 7. Review verdict

The Core boundary is valid, but the architecture is not yet frozen for implementation.

Before implementation, V3 must explicitly finalize:

1. Core Instance/Slot identity and shared Host identity;
2. host-level shared-state coordination;
3. the exact preservation contract for V2 A/B deployment semantics.

Everything else should continue to build on V2 rather than replace it.


