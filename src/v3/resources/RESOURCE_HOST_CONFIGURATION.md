# Independent Host Resource Coordinator configuration

The executable is `dist/v3-resource-host.js`. It owns **one** persistent Coordinator and exposes one authenticated loopback listener per configured Slot. A and B must connect to this shared process; they must not each construct a Coordinator against the same resource database.

This is a working local coordination/control interface. It does not open MATLAB, drive hardware, stop an external executor, or automatically wire every V3 capability into a resource broker.

## 1. Private deployment inputs

The local operator must first provision a private directory outside every engineering Workspace. The process reads `P05_V3_RESOURCE_CONFIG`, an absolute local JSON configuration file path. The configuration file, its containing directory, and the existing `stateDir` must pass the real read-only OS protection probe before a listener starts.

- Windows: current user, SYSTEM and Administrators are the only accepted owner/access identities. Inherited rules, children and reparse points are examined. The entrypoint does not silently change user ACLs.
- POSIX: paths must be owned by the current UID, private to that owner and free of symlinks. Newly created state files use a private creation mask.
- State and configuration cannot be inside a configured Workspace; Workspace and resource-state directories must be disjoint. Use a local filesystem, not a network share.
- This protects local credentials/state against other OS identities according to the probe. Same-OS-user processes remain inside the trusted-host boundary. It is not an execution sandbox.

Example configuration, with paths adapted to the local installation:

```json
{
  "version": 1,
  "hostId": "replace-with-shared-core-host-id",
  "stateDir": "C:/P05-Private/resource-host/state",
  "slots": [
    {
      "slotId": "A",
      "principalId": "principal-a",
      "workspaceRoot": "D:/Projects/WorkspaceA",
      "port": 0
    },
    {
      "slotId": "B",
      "principalId": "principal-b",
      "workspaceRoot": "D:/Projects/WorkspaceB",
      "port": 0
    }
  ]
}
```

`hostId` must be copied from the owning Host's trusted Core identity; it is not an IP address or Slot ID. `principalId` must match the authenticated identity assigned to that Slot's Core. The Host stores each Slot/principal/Workspace binding and rejects a later silent identity change. Identity migration needs a separate reviewed procedure and credential rotation; editing the JSON alone does not reassign old contexts.

`port: 0` allocates a loopback port; a fixed available port is also supported. At most 16 distinct Slots are accepted. No network/public bind option exists.

Start after building:

```powershell
$env:P05_V3_RESOURCE_CONFIG = 'C:\P05-Private\resource-host\resource-config.json'
node dist/v3-resource-host.js
```

The process emits a `p05.v3.resource.ready` JSON event on stderr with the Host ID, per-Slot endpoint and credential-file paths. It writes the same local discovery information to `stateDir/resource-host.json`. The pointer is not proof of liveness; clients must authenticate and query `resource_status`. Re-read it after a Host restart because ephemeral ports may change.

## 2. Credentials and ownership

The Host creates/preserves:

- `stateDir/operator.token`: privileged local Host operator credential.
- `stateDir/slot-<hash>/client.token`: a distinct credential for each Slot Core.
- `stateDir/coordinator-lock.sqlite`: lifetime OS-backed exclusive Coordinator lock.
- `stateDir/resources.sqlite`: resources, leases, epochs, waiters and recovery records.
- `stateDir/resource-contexts.sqlite`: Slot identity bindings, trusted run contexts and request mappings.

Credentials are never returned as token text in readiness or diagnostics. Duplicate client/operator credentials are rejected. Do not send resource client credentials, the Host operator credential, or the discovery file to the MCP Edge/Agent. Resource clients are trusted Core/broker processes. The public MCP transport's client credential is a different credential for a different boundary.

Authenticating on A's listener fixes A's Slot and principal. Payload fields cannot replace either. B's credential is rejected on A's listener. The privileged operator credential is Host-scoped and works at the configured listeners; ordinary Slot clients cannot register resources, grant contexts, inspect other holders, quarantine or request recovery.

## 3. Establish a bounded Run context

A ResourceHost cannot infer Run authorization from caller-supplied strings. Before a Slot Core can acquire a resource, the trusted local operator/registrar must establish an immutable context on that Slot's listener **after** verifying the real accepted Run, captured principal, executor/boot identity, resource permissions and approval.

The initial release exposes this privileged registration operation; it does not fabricate a lookup into every Core's Run database. A future automatic registrar must authenticate that lookup and retain the same boundary. Giving an Agent the operator credential to register its own contexts is not an integration solution.

Operator-only `resource_context_register` input:

```json
{
  "contextId": "context-for-run-a",
  "runId": "actual-durable-run-id",
  "executorId": "actual-executor-id",
  "executorBootId": "actual-executor-boot-id",
  "resourceIds": ["matlab-session-1"],
  "expiresAt": 1790812800000,
  "maxLeaseMs": 30000
}
```

`expiresAt` is an absolute Unix time in milliseconds; the example is illustrative and must be replaced by a future deadline, at most 24 hours away. `maxLeaseMs` is 1–300,000 ms. All resources must already be registered. Contexts cannot be rebound or widened, and a Slot Run cannot be aliased through several context IDs. The Host captures Slot and principal from listener configuration rather than accepting them in this input.

For a different Run/executor identity or expanded permission, create a separately authorized context. There is currently no context-extension shortcut. Limits are 4,096 persisted contexts and 1,024 request mappings per context; reaching a limit fails explicitly. Automatic retention/GC and context migration are not implemented.

## 4. RPC operations

Use the existing authenticated loopback client from `v3/transport/rpc`. Transport authentication failures are transport errors. Domain failures are returned as `{ "error": { "code": "..." } }`; callers must check this field before interpreting a response as success.

| Method | Allowed role | Contract |
|---|---|---|
| `resource_status` | Client/operator | Empty input; reports fixed identity, readiness and actual limitations |
| `resource_register` | Operator | Immutable resource descriptor: ID, kind, physical identity, mode, capacity, adapter |
| `resource_inspect` | Operator | `{resourceId}`; holder diagnostics omit bearer tokens |
| `resource_context_register` | Operator | Bounded immutable context described above |
| `resource_context_revoke` | Operator | `{contextId}`; persist revocation, cancel its waiters and quarantine active holders |
| `resource_acquire` | Client/operator | `{contextId,resourceIds,ttlMs,waitMs?,idempotencyKey}` |
| `resource_request` | Client/operator | `{contextId,requestId}`; query only a request mapped to that context |
| `resource_cancel_wait` | Client/operator | Same input; cancel a waiting request, never silently release a granted lease |
| `resource_lease` | Client/operator | `{contextId,credential}`; verify owner and bearer token before returning state |
| `resource_validate` | Client/operator | `{contextId,credential,resourceId}`; adapter pre-operation validation |
| `resource_renew` | Client/operator | `{contextId,credential,ttlMs}`; bound to context lifetime and lease maximum |
| `resource_release` | Client/operator | `{contextId,credential}`; active owner's clean relinquishment only |
| `resource_quarantine` | Operator | `{resourceId,reason}`; safe uppercase diagnostic reason |
| `resource_reconcile` | Operator | Currently always rejects with `RECOVERY_VERIFIER_UNAVAILABLE` |

`credential` is exactly `{leaseId,fencingEpoch,token}`, obtained from the original acquisition/query. Context ID alone is not sufficient to renew, release or operate a lease. Acquisition idempotency is namespaced by fixed Slot, principal, context and caller key; no caller can use another context's request ID to retrieve its credentials.

The default queue is bounded and FIFO. The Host pumps it every 250 ms and after release. Expired/revoked/removed-Slot contexts have their waiters cancelled before pumping. Waiting while already holding another bundle is rejected. Multi-resource acquisition is all-or-none.

## 5. Expiry, crashes and unavailable recovery

Lease expiry, revocation and Coordinator restart do **not** prove that a physical operation stopped. They quarantine uncertain ownership and prevent handover. Every reopen retains old lease identity and fencing epoch. New clients cannot steal these resources after the Host process dies.

The standalone entrypoint deliberately has **no** termination verifier because no actual device/executor adapter is wired into it yet. `resource_reconcile` therefore rejects even a privileged caller's `{terminated:true}` assertion. Do not delete the database or lower/reset epochs to force recovery. A future trusted adapter must inspect the old executor/boot identity, obtain concrete stop/reconciliation evidence, and feed that evidence to the underlying Coordinator's verifier contract.

Leases themselves are cooperative coordination. They neither stop processes nor enforce exclusive hardware access. A non-fenceable device needs a single actual broker holding its OS/device handle and checking the lease before effects. Configuration records naming an adapter do not instantiate such a broker.

If internal maintenance fails, readiness becomes false and new state-changing RPC work is stopped until controlled recovery/restart. Closing this process does not close Slot Core or erase accepted resource history.

## 6. Verified behavior

`node dist/test/v3-resource-host.js` launches real independent Node child processes using fresh private test directories, authenticates both Slot listeners, exercises contention and ownership rejection, kills/restarts the Host, and verifies old owners remain quarantined. It also verifies startup refusal for a directory whose actual ACL/mode is not private. The ACL-tightening fixture changes only newly created empty test directories; it does not alter user installations or services. No MATLAB/hardware operation is performed.
