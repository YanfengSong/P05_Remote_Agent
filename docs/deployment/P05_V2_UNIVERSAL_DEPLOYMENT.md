# P05 Remote Agent V2 — Universal Deployment and Git State Synchronization

Status: Operational  
Branch: V2  
Target: Windows x64

## 1. Purpose

This document is the canonical deployment contract for installing P05 on another computer and keeping that installation aligned with the Boonray development machine.

The target computer must never depend on direct access to Boonray's filesystem. Boonray publishes tested source code and the portable Golden State manifest to Git; target computers pull Git and apply that state locally.

The model is:

    Boonray development
          |
          | commit + publish
          v
       Git / V2
       /       \
      v         v
    Host A    Host B
      |         |
    Sync      Sync
      |         |
    local     local
    runtime   runtime

## 2. What is synchronized

Git source code provides parity for GUI, backend logic, Capability/Policy, Runtime lifecycle, Plugin framework, tests and deployment scripts.

sync/golden-state.json provides parity for portable shared configuration:

- Tool Profile;
- Approval Mode;
- Runtime slot topology;
- active Workspace ID;
- logical Workspace IDs, labels and plugin allowlists;
- logical Reference IDs and labels;
- Plugin/downstream metadata derived from the same source tree;
- Capability catalog identity.

## 2.5 Repo-root containment

P05 V2 follows a strict **Repo-Root Contained Runtime** invariant. Persistent files created or managed by P05 stay under the cloned Git repository; the normal runtime does not use the Windows user profile or global application-data directories as a P05 storage location.

The managed tree is:

    <repo>\
      .env
      .npmrc
      node_modules\
      dist\
      .p05\
        tools\
          node\
          tunnel-client\
          matlab\
            agentic-toolkits\
        npm-cache\
        runtime-a\state\
        runtime-b\state\

Temporary installer downloads may use the operating-system temporary directory and are deleted after installation. Workspace and Reference roots remain external by design because they are user/project data, not P05 runtime files.

Run the path audit with:

    npm run path:audit

The audit fails if executable P05 code reintroduces user-profile/global-app-data persistence or if repo-local P05 path settings in .env point outside the repository.

## 3. What remains machine-local

The following values must not be copied from Boonray to another computer:

- Device ID;
- Tunnel ID;
- connector names;
- CONTROL_PLANE_API_KEY;
- OAuth client secrets/tokens;
- absolute Workspace filesystem roots;
- Reference filesystem roots;
- audit/recovery history;
- live process state;
- local network/proxy configuration;
- MATLAB installation/session state.

A logical Workspace ID is shared, but its root directory is resolved locally. A logical Reference ID is shared, but its root directory is resolved locally.

**Never copy another host's .env or .p05 directory.**

## 4. First-time deployment

Prerequisites:

- Windows x64;
- Git;
- PowerShell;
- network access required by the configured GitHub/OpenAI/package endpoints.

Clone V2 directly:

    git clone --branch V2 --single-branch <P05 repository>
    cd P05_Remote_Agent

Run Bootstrap once:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1

Bootstrap installs the pinned repo-local toolchain, creates machine-local .env and .p05 state, keeps the npm cache under .p05, uses the repo-local MATLAB toolkit location when available, creates Runtime state directories, generates Runtime profiles and can start the selected Runtime slots.

Configure only this computer's values:

- Runtime A/B Tunnel ID(s);
- Runtime A/B connector name(s);
- OpenAI Control Plane API key;
- REMOTE_AGENT_ALLOWED_ROOTS;
- optional network/proxy settings.

The current validated toolchain is Node.js 22.23.1 and tunnel-client 0.0.14. Bootstrap verifies and installs these into .p05/tools. MATLAB Agentic Toolkit, when enabled, is expected under .p05/tools/matlab/agentic-toolkits. If an older P05 host still has the toolkit under %USERPROFILE%\.matlab\agentic-toolkits, run `P05-Migrate-MATLAB.cmd` once, verify the plugin, then rerun it with `-RemoveLegacy` to remove the old copy.

## 5. Workspace and Reference binding

A fresh machine must bind shared logical IDs to its own local directories.

If Golden State contains project-a and project-b but those directories have different locations on the new computer, create:

    .p05\sync-workspace-map.json

Example:

    {
      "project-a": "C:\\Engineering\\ProjectA",
      "project-b": "D:\\Work\\ProjectB"
    }

Mapped directories must already exist and must be inside REMOTE_AGENT_ALLOWED_ROOTS.

If a Workspace is already registered locally with the same logical ID, State Sync preserves that local root and does not replace it with a Boonray path.

Reference roots follow the same principle: the ID/label is shared from Git, while the actual local root must already be registered on the target.

## 6. Normal update operation

After Bootstrap has completed once, the normal update operation is:

    P05-Sync.cmd

Equivalent command:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync\sync-machine.ps1

The controlled sequence is:

    clean Git tree check
      -> V2 branch and upstream check
      -> git pull --ff-only
      -> Golden State/source-commit validation
      -> npm ci when package manifests changed
      -> build current Git revision
      -> apply Golden State
      -> regenerate local Runtime profiles
      -> per-Runtime drift verification
      -> restart Runtime slots that were already ready
      -> restart Operator Console if it was already running
      -> P05 STATE SYNC OK

A dirty Git tree stops the operation. State Sync never performs git reset --hard, force checkout or force push.

Useful diagnostics:

    .\scripts\sync\sync-machine.ps1 -DryRun

    .\scripts\sync\sync-machine.ps1 -SkipRestart

## 7. Boonray release operation

When a feature or fix is complete on Boonray:

1. Finish the GUI/backend/code changes.
2. Run the normal verification suite.
3. Commit the code changes to V2.
4. Ensure the source tree is clean.
5. Publish the current shared state:

    .\P05-Publish-State.cmd

Equivalent:

    .\scripts\sync\publish-golden-state.ps1

The publisher verifies the repository, exports sync/golden-state.json, checks for known secret fields and current-user paths, and commits only the Golden State artifact.

Then push:

    git push origin V2

Only after the push succeeds is the new state available to other computers.

## 8. Golden State contract

sync/golden-state.json is a versioned, committed desired-state artifact.

Schema version 1 contains:

    source
      agentVersion
      gitCommit

    policy
      toolProfile
      approvalMode

    runtime
      slots[]

    workspace
      activeId
      entries[]

    references[]

    plugins[]

    downstream[]

    capabilities
      names[]
      catalogSha256

The Golden State revision is based on the configuration content, not generatedAt or source gitCommit. This avoids configuration drift being caused only by a new source commit or manifest generation timestamp.

Golden State is not a backup of .env or .p05. It is a portable desired-state contract.

## 9. Failure handling

Dirty target repository:
Resolve or stash the local change, return to a clean V2 tree, then run P05-Sync.cmd again.

Wrong branch:
Use V2 with an upstream to origin/V2. Do not force-reset a target simply to make synchronization pass.

Missing Workspace root:
Register the Workspace locally or create .p05\sync-workspace-map.json, ensure the path exists and is allowed, then retry.

Missing Tunnel ID:
The target must have its own valid Tunnel ID for every Runtime slot requested by Golden State. Never reuse Boonray's Tunnel ID.

Unresolved drift:
State Sync refuses to restart Runtime services if the post-apply state still differs from Golden State. Investigate the reported drift before retrying.

## 10. Deployment acceptance

A target machine is considered successfully deployed when:

- Git is on V2 with the correct upstream;
- the working tree is clean;
- Bootstrap/preflight passes;
- repo-local Node/npm and tunnel-client pass validation;
- the current Git revision builds successfully;
- required Runtime slot(s) reach /readyz;
- device_info and ping succeed;
- Golden State applies without unresolved local binding errors;
- every configured Runtime returns status in_sync;
- Operator Console starts when required;
- GUI/backend behavior comes from the same Git revision identified by Golden State source.gitCommit.

Fresh-machine lifecycle:

    Clone V2
      -> Bootstrap once
      -> configure machine-local identity
      -> bind local Workspace/Reference roots
      -> P05-Sync.cmd
      -> verify zero drift
      -> operate normally

## 11. Responsibilities

Boonray is the development and publishing host, not a runtime dependency.

Boonray responsibilities:

- develop and test code;
- commit changes;
- publish Golden State when shared state changes;
- push V2.

Target-machine responsibilities:

- maintain local credentials and Tunnel IDs;
- maintain local Workspace/Reference roots;
- pull V2;
- run P05-Sync.cmd;
- resolve machine-local failures.

This separation allows multiple independent P05 computers to converge on the same application behavior without sharing machine identity.

## 12. Canonical implementation files

    bootstrap.ps1
    scripts/deployment/README.md
    scripts/sync/README.md
    scripts/sync/sync-machine.ps1
    scripts/sync/publish-golden-state.ps1
    scripts/sync/apply-golden-state.mjs
    scripts/sync/check-drift.mjs
    scripts/sync/local-workspace-map.example.json
    sync/golden-state.json

If implementation and documentation ever disagree, update the documentation in the same change. The executable scripts and automated tests are the implementation authority.
