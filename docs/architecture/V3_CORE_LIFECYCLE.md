# P05 V3 Core Lifecycle, Upgrade and Rollback Design

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Objective

Because Core is the final recovery entry point, Core upgrades must be more conservative than optional feature upgrades.

Core MUST NOT depend on its own currently running process to be the only mechanism capable of replacing or recovering itself.

## 2. Authority split

Core owns update diagnostics and may request an update.

An external host-level launcher/updater owns:

- starting a candidate Core;
- switching the active Core slot/version;
- restoring the last known-good Core;
- recovering when the current Core cannot start.

This follows the same principle as the external restart broker.

## 3. Version model

Lifecycle tracks separately:

- Core application version;
- MCP/protocol compatibility version;
- Core recovery-contract version;
- bootstrap trust/config schema version;
- Optional Runtime bridge API version;
- persisted state schema versions.

One version string must not be overloaded to represent all compatibility dimensions.

## 4. Upgrade sequence

Target safe sequence:

```text
current known-good Core
   |
   +-> stage candidate
   +-> validate files/signature/source policy
   +-> validate config/schema compatibility
   +-> start candidate in inactive slot
   +-> candidate self-test / local health
   +-> verify minimum recovery surface
   +-> switch active endpoint/connector
   +-> observe stabilization window
   +-> mark candidate known-good
   +-> retire previous slot later
```

Core source/binary is never destructively overwritten before a candidate proves it can start.

## 5. Rollback

Rollback triggers include:

- candidate cannot start;
- minimum recovery tools unavailable;
- bootstrap trust/config migration failure;
- repeated crash during stabilization;
- remote connector cannot establish compatible route after switch;
- explicit operator rollback.

Rollback restores the last known-good Core slot/version.

Optional feature failure alone is not sufficient reason to roll back a healthy Core; that normally produces DEGRADED mode.

## 6. State migration

State classes are treated differently.

### Bootstrap trust state

Migration must be explicit, versioned and reversible or backed up before activation.

If migration cannot be proven safe, candidate stays inactive.

### Non-authoritative state

May be rebuilt/quarantined if incompatible, without broadening authority.

### Optional Runtime state

Owned outside Core and must not block Core rollback.

## 7. Compatibility window

A new Core SHOULD support at least the bridge/protocol compatibility window explicitly promised by release metadata.

Incompatible Optional Runtime versions are isolated and reported instead of forcing Core failure.

## 8. Single active authority

Only one Core instance/slot may own the active external control endpoint for a device at a time.

Candidate validation can run locally on an isolated administrative endpoint, but it must not accidentally become a second authoritative remote control plane.

## 9. Upgrade safety invariants

LIFE-01: No in-place destructive Core replacement before candidate health verification.

LIFE-02: Last known-good Core is retained until candidate stabilization completes.

LIFE-03: State migration cannot silently widen authority.

LIFE-04: Failed candidate does not modify the active Core''s runtime truth.

LIFE-05: External launcher/updater can restore Core even when Core MCP is unavailable.

LIFE-06: Upgrade logs/status contain no secrets.

## 10. Acceptance

1. Candidate fails to boot -> old Core remains active.
2. Candidate boots but fails recovery self-test -> no cutover.
3. Candidate crashes during stabilization -> rollback.
4. Optional Runtime is incompatible -> Core remains active in DEGRADED mode.
5. Rollback restores remote/local control without manual repository surgery.


