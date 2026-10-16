# P05 State Synchronization

Git is the distribution and synchronization channel for P05.

Boonray is the development machine, but it is not a runtime dependency. Other
machines never read Boonray's filesystem. They only consume the committed Git
repository and the committed Golden State manifest.

## Release workflow on Boonray

1. Finish and commit the P05 code/GUI/backend changes.
2. Run scripts\sync\publish-golden-state.ps1.
3. Push the V2 branch to origin.

The publish script verifies the repository, exports sync\golden-state.json, checks
that the artifact does not contain known secret fields or the current user profile
path, and commits only the Golden State file.

The Golden State file is intentionally committed to Git. It is the desired shared
configuration for all deployments. It does not contain absolute Workspace/Reference
paths, Device IDs, Tunnel IDs, API keys, OAuth secrets or live process state.

## Update workflow on another computer

After the machine has already been bootstrapped once, run:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync\sync-machine.ps1

The script:

    Git pull --ff-only
    -> verify Golden State source commit
    -> npm ci only when package manifests changed
    -> build
    -> apply shared state
    -> regenerate local Runtime profiles
    -> verify drift is zero
    -> restart already-running Runtime/Operator processes

A local dirty Git tree, a divergent branch, missing upstream, missing machine
configuration, failed build, unresolved Workspace mapping, or failed drift check
stops the operation. No Git reset, force checkout, or force push is performed.

git pull --ff-only is deliberate: it refuses to integrate when the target machine
has diverged instead of silently overwriting local commits.

## What Git synchronizes

The Git commit synchronizes source code and therefore the GUI, Core backend,
Policy/Permission implementation, Runtime lifecycle, Plugin/Downstream logic,
tests and deployment scripts.

sync\golden-state.json synchronizes shared configuration such as Tool Profile,
Approval Mode, Runtime slot topology, active Workspace ID, logical Workspace
definitions, Reference identities, and plugin/downstream metadata.

package-lock.json remains committed so dependency installation can be reproduced
from the same lockfile.

## What remains machine-local

Absolute filesystem paths are never copied from Boonray. A Workspace ID is portable;
its root is resolved locally.

Existing local Workspace roots are matched by Workspace ID. If a desired Workspace
does not exist locally, create .p05\sync-workspace-map.json with the missing IDs mapped
to absolute local directories. The example file is
scripts\sync\local-workspace-map.example.json. The mapped directory must already
exist and be inside REMOTE_AGENT_ALLOWED_ROOTS.

Reference roots follow the same principle: the reference ID/label comes from Git,
while the local root must already be registered on the target machine.

Device ID, hostname, Tunnel ID, connector name, API key, OAuth client/secret, local
application installation, proxy configuration, audit/recovery history and live
Runtime state remain local.

## Phase boundary

Phase 2 is controlled Git-based reconciliation, not direct Boonray-to-machine
synchronization. The next layer can add automatic polling or a scheduled task, but
the source of truth remains the Git branch plus committed Golden State artifact.
