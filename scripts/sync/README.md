# P05 State Synchronization — Phase 1

Phase 1 defines a portable Golden State contract. It does not apply changes to a target machine.

## Golden State

Run this on the Boonray/source machine after the desired P05 state is ready:

    npm run sync:export

The default output is sync/golden-state.json. Treat that file as a versioned desired-state artifact when it is safe to publish with the repository.

The exported manifest intentionally excludes machine identity and absolute host paths. It records the P05 source commit, tool profile, approval mode, runtime slot topology, logical workspaces, reference identities, plugin/downstream configuration, and the core capability catalog hash.

Do not add secrets, tunnel IDs, connector credentials, API keys, device identity files, .env, or .p05 runtime state to the Golden State artifact.

## Drift detection

On another already-deployed P05 machine:

    npm run sync:drift -- sync/golden-state.json

Exit code 0 means the machine is in sync. Exit code 2 means drift was detected; the command prints the exact manifest paths that differ.

This phase is intentionally read-only. Drift detection does not pull code, change configuration, restart Runtime processes, or modify Workspace registrations.

## State boundary

Golden State describes what should be consistent across machines.

Machine-local state remains local:

- absolute Workspace and Reference paths;
- Device ID and hostname;
- Tunnel IDs and Connector names;
- API keys, OAuth secrets and tokens;
- installed external application paths;
- audit/recovery history;
- live Runtime process state.

Code and GUI behavior are synchronized by the Git source commit recorded in the manifest. Phase 2 will add controlled reconciliation and apply/rollback.
