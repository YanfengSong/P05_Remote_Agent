# Optional composition and assets

This module implements a small local Composition runtime from technical solution sections 15–18. It is **not** the complete plugin installer, V2 plugin bridge, separate Optional Host process, arbitrary-code sandbox, package-signature verifier or full hot-module-replacement system.

## Integration

1. Create `CompositionRuntime` in the Optional Host, not inside the Core trust kernel. Load only installed code whose manifest digest was verified by the trusted loader; the runtime validates manifest structure, not executable provenance.
2. Pass `desiredStore` backed by the owning Slot's controlled store API. `CoreState` satisfies this narrow API; keys use `service:composition:`. Without it, status explicitly reports memory-only desired state. One runtime owns each namespace; do not start two concurrent controllers over the same namespace.
3. Create platform/workspace/agent/run/shadow scopes. Scopes control service visibility only and confer no permissions.
4. Register typed definitions and Zod config schemas, then `reconcile()`. Single-provider keys are unique in a realm; multiple contributors must declare `registry`. Missing dependencies stay pending. Cycles and conflicting providers are rejected before activation.
5. Resolve via `pin`/`pinRegistry`; retain the pin through the entire asynchronous operation and release in `finally`. A raw service value used after releasing its pin is caller misuse. The outer Capability/Run boundary still performs authorization.
6. `replace` validates and activates a candidate before changing new-request resolution. Candidate failure preserves the previous binding and applied revision. Old service callers continue using their pinned generation; `waitForDrain` is bounded and reports false when work remains. It never kills an external resource to make draining appear complete.
7. `setDesired` uses an expected revision; an enabled component with `manualHold` stays stopped through reconciliation and persisted restart. `close` retires local fibers; it does not persist an implicit user disable.

## Effects and hooks

- `onDispose`, `interval`, `observe` and `intercept` require declared E1 ownership. Owned cleanups are idempotent and run in reverse order. Timers and listeners are actually removed. Async callbacks pin their fiber while running; retired and unpublished callbacks admit no new work.
- E2/E3/E4 must declare an external manager and call the configured `executeExternal` gateway. That gateway must enforce the original immutable execution context, policy, resource leases and durable receipts. The runtime records external outcomes and never reports them automatically undone by configuration rollback or fiber disposal.
- Shadow and its descendants reject the controlled external-effect gateway. Arbitrary imported JavaScript can still call OS APIs directly; real candidate-code isolation requires the separate execution backend/Optional Host. There is no OS-isolation claim here.
- Event observers receive deep-frozen cloned JSON snapshots. They cannot change publisher data. Slow observations are dropped under backpressure; failing/timed-out subscriptions are removed. These are not durable events.
- Interceptors run only at named extension points, with deterministic priority and bounded asynchronous waiting. Output is strictly limited to non-authoritative metadata and a deny flag; later hooks cannot reverse a denial or rewrite actor/authority/approval fields. Synchronous infinite loops and native crashes still require process isolation.

## Assets

`AssetStore` writes SHA-256-addressed blobs and SQLite metadata in an operator-protected local directory. Blobs are staged and synced before publication, and reads verify their digest. Revisions and Artifacts are immutable. DRAFT → VERIFIED requires a configured trusted evidence verifier; VERIFIED → ACTIVE checks the exact digest and deprecates the previous active revision in one transaction. Revocation cannot be bypassed by reactivation. Artifact promotion records provenance and creates a new DRAFT requiring verification.

Asset activation does not grant execution authority. Visibility checks belong to the authenticated outer API. The store does not implement package signatures, arbitrary download/install, retention GC, large-file streaming, or a power-loss qualification of every filesystem. Blob size is currently capped at 8 MiB. Metadata must not contain raw secrets.

Tests: `node dist/test/v3-composition.js` after build; all files and content are temporary test artifacts.
