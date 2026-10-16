# ADR-0021: Git-Based Universal State Synchronization

Status: Accepted  
Date: 2026-10-16

## Context

P05 must run on multiple independent Windows engineering computers while keeping GUI behavior, backend logic, policy, runtime implementation and shared operational configuration consistent.

A target computer must not depend on direct filesystem access to Boonray. Boonray may be offline or physically isolated after publishing a version.

## Decision

Git is the distribution channel and source of truth for P05 source code and the portable shared-state contract.

The synchronization model is:

    Boonray development
          |
          | commit + publish
          v
       Git / V2
          |
          | git pull --ff-only
          v
      Target P05
          |
          | apply Golden State
          v
    Local Runtime / Operator

The shared-state contract is sync/golden-state.json.

A target applies that manifest through scripts/sync/sync-machine.ps1. The process verifies the desired state after application and does not restart Runtime services when unresolved drift remains.

## Machine-local boundary

Never synchronize these values through Golden State:

- Device IDs;
- Tunnel IDs;
- API keys and OAuth secrets;
- connector names;
- absolute Workspace/Reference paths;
- audit/recovery history;
- live process state;
- host-specific network configuration.

Logical Workspace and Reference identities are shared; filesystem roots remain local.

## Release protocol

Boonray follows:

    code changes
      -> commit
      -> full verification
      -> publish Golden State
      -> push V2

The publish operation is fail-closed for a dirty source tree and rejects known secret or host-path leakage.

## Target protocol

A bootstrapped target follows:

    P05-Sync.cmd
      -> clean-tree check
      -> V2/upstream check
      -> git pull --ff-only
      -> Golden State/source-commit validation
      -> dependency install when required
      -> build
      -> local state apply
      -> Runtime profile regeneration
      -> per-slot drift verification
      -> restart only previously-ready services

No target operation performs a force reset or force push.

## Consequences

Positive:

- Boonray is not a runtime dependency.
- Multiple target computers can converge through Git.
- Code parity and configuration parity are explicit and auditable.
- Machine identity remains isolated.
- A partially configured target cannot silently overwrite local code/configuration.

Tradeoffs:

- Every target must be bootstrapped once.
- Local Workspace/Reference roots require machine-specific registration.
- Local Git modifications must be resolved before synchronization.
- Git/V2 availability is required to distribute new state.

## Rejected alternatives

Direct Boonray filesystem synchronization was rejected because it creates a hidden host dependency.

Copying .env or .p05 was rejected because those contain credentials, machine identity and runtime-local state.

Blind git pull without state application was rejected because source-code parity does not guarantee runtime configuration parity.

Automatic force-reset to the Git branch was rejected because it can destroy legitimate local work and violates fail-closed deployment behavior.

## Operational documentation

The canonical deployment guide is:

    docs/deployment/P05_V2_UNIVERSAL_DEPLOYMENT.md

Supporting implementation guides are:

    scripts/deployment/README.md
    scripts/sync/README.md


## Repo-root containment

P05 V2 adopts **Repo-Root Contained Runtime** as a deployment invariant. Persistent P05 state, managed binaries, npm cache, generated Runtime profiles, Runtime state, health files and logs must resolve inside the Git repository.

The application must not use USERPROFILE, APPDATA, LOCALAPPDATA or PROGRAMDATA as a P05 storage root. Explicit state/toolkit path overrides are accepted only when they remain inside the repository.

External Workspace/Reference roots and the installed MATLAB application are host dependencies/data, not P05-generated runtime files. OS temporary directories may be used only for transient installer downloads and must be cleaned after use.

The invariant is enforced by runtime path guards and the `npm run path:audit` deployment audit.
