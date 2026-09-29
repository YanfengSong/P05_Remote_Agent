# Host resource coordinator

This module implements the local persistent part of technical solution section 13. It does not access MATLAB, hardware, OS resource handles, or remote machines.

- Provision exactly one protected, local `stateDir` per Host; this path and `hostId` come from trusted deployment configuration. Do not place it in an agent-writable Workspace or a network filesystem. Windows ACL verification belongs to the hosting Core/launcher.
- A dedicated SQLite DELETE-journal connection holds an exclusive OS file lock for the Coordinator lifetime. Never remove or replace the lock file while a Coordinator may be running. The resource database uses WAL and full synchronous commits.
- `registerResource` fixes physical identity, mode and capacity. Physical identities cannot be registered under two aliases. Descriptor changes require an explicit migration.
- `acquire` grants the entire sorted resource bundle in one transaction, or none. `requestId` retries return the original request; changed intents conflict. A granted request stays `GRANTED` even after its leases finish; inspect lease states to determine present ownership.
- `waitMs` creates a bounded FIFO waiter, without partial reservations. Owners already holding a bundle cannot queue for another. Run `pumpQueue()` from the trusted coordinator's scheduler and after releases/cancellations; there is no hidden background timer. FIFO can intentionally block unrelated requests behind a blocked head.
- Every adapter operation must call `validateToken(resourceId, credential, owner)`. `owner` is captured authenticated execution context, not caller-supplied identity. Shared leases have distinct monotonically increasing epochs; an older *active shared lease* remains valid until released, expired or quarantined.
- Leases coordinate cooperating adapters. They do not enforce OS exclusion, stop processes, revoke device handles or confer authorization. Non-fenceable devices require a single real broker owning the device handle. Validation alone is not an atomic device operation.
- Expiry quarantines the resource and retains its holder. Every reopen quarantines remaining active owners, even after a clean Coordinator shutdown: stopping the Coordinator does not establish that external executors stopped. Query/pump/acquire/validation evaluate expiry; no timer automatically reassigns a resource.
- `release` is permitted only after the adapter has stopped using an active resource. Repeating a completed release is harmless. Expired/quarantined leases require `reconcileLease` instead.
- `reconcileLease` requires the old epoch, matching executor/boot identity and evidence accepted by a configured trusted `verifyTermination`. Without that verifier recovery fails closed. Do not implement the verifier as acceptance of a remote caller's Boolean assertion. Recovery is audited in the same transaction as release. All quarantined shared holders must be reconciled before the resource becomes available.
- `inspect`, registration, quarantine and recovery are trusted local administration interfaces. Diagnostic views omit bearer tokens. Request/lease queries, renew and release verify ownership; the outer Core still authenticates access and applies authorization.

The integration must expose absence/failure as resource-dependent capability unavailability, while retaining unrelated Core diagnostics and recovery tools. SQLite persistence cannot guarantee that a physical operation ran exactly once or that a resource remains safe after an executor failure.

Run `node dist/test/v3-resources.js` after compiling. Tests use temporary directories, a fake time source and owned test child processes; no engineering tools or user services are controlled.
