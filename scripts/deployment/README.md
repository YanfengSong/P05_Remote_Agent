# P05 Repo-local Deployment

P05 is deployed from one Git repository. Runtime binaries, tunnel profiles, logs,
health files and per-runtime state are machine-local under `<repo>/.p05` and are
ignored by Git.

## Target layout

```text
P05_Remote_Agent/
├─ bootstrap.ps1
├─ P05-Operator.cmd
├─ src/
├─ dist/
├─ scripts/deployment/
└─ .p05/
   ├─ tools/
   │  ├─ node/
   │  └─ tunnel-client/
   ├─ tunnel/
   │  ├─ profiles/
   │  ├─ health/
   │  └─ logs/
   ├─ runtime-a/state/
   └─ runtime-b/state/
```

No Windows Scheduled Task is required by the normal runtime path.

## Fresh machine

Prerequisites:

- Windows x64
- Git
- PowerShell
- outbound HTTPS access to Node.js, GitHub/OpenAI and `api.openai.com`
- two pre-created OpenAI Tunnel IDs, one for `@Boonray-A` and one for `@Boonray-B`
- one control-plane API key

Clone the repository, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

The script first asks for Runtime topology:

1. Single Runtime A (default)
2. Dual Runtime A+B

It then prompts only for the Tunnel ID(s) required by that topology and one OpenAI control-plane API key.

By default the outer authorization root is the P05 repository itself. An explicit
larger authorization perimeter can be supplied with `-AllowedRoots`.

Bootstrap begins with a deployment preflight. It checks Windows/x64, PowerShell, Git, repository validity, repo-local write access, allowed-root configuration, `.env.example`, and the actual executability/version of repo-local Node/npm/tunnel-client.

Preflight result meanings:

```text
PASS        environment is ready for the next step
REPAIRABLE  managed repo-local tools are missing/broken and Bootstrap can reinstall them
FAIL        a host/config prerequisite requires user action
```

With normal Bootstrap, missing or broken managed Node/npm/tunnel-client installations are repaired and then validated again by PostInstall preflight. With `-SkipToolDownload`, the same condition fails closed instead of being silently accepted.

A standalone read-only check is available with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deployment\preflight.ps1
```

Bootstrap:

- runs PreInstall and PostInstall environment validation;
- downloads pinned Node.js and tunnel-client releases when repair is required;
- verifies SHA-256 checksums from their published checksum manifests;
- verifies installed Node/tunnel-client versions and confirms npm actually executes;
- installs them into `.p05/tools`;
- creates the Git-ignored machine-local `.env`;
- runs `npm ci` and `npm run build`;
- writes `P05_RUNTIME_SLOTS` explicitly;
- creates tunnel profiles and state directories only for configured Runtime slots;
- does **not** start Operator or either Runtime;
- does **not** install automatic startup.

## Daily use

Double-click:

```text
P05-Operator.cmd
```

Operator Console starts from the repo-local Node executable and opens:

```text
http://127.0.0.1:56301/
```

From the GUI:

- Runtime A controls `@Boonray-A` when A is configured.
- Runtime B controls `@Boonray-B` when B is configured.
- Fresh installs default to Runtime A only; dual A+B is optional.
- Each Runtime has independent start/stop/restart and Workspace binding.
- Closing Operator does not stop A or B.
- Restarting A does not affect B, and vice versa.

Runtime state is persistent under `.p05/runtime-<slot>/state` for configured slots. Workspace bindings survive Runtime restart. An unconfigured slot is reported as `NOT CONFIGURED`, not as a deployment failure.

## Deployment diagnostics

- `preflight.ps1`: read-only environment/dependency validation entry point.
- `preflight-lib.ps1`: shared Preflight functions used by Bootstrap and future Doctor.
- `test-preflight.ps1`: Windows regression test for Preflight semantics.

## Runtime scripts

- `launch-runtime.mjs`: one shared P05 launcher; receives slot A or B.
- `run-runtime-slot.ps1`: starts one repo-local tunnel/runtime.
- `stop-runtime-slot.ps1`: stops only the selected slot and its child P05 process.
- `restart-runtime-slot.ps1`: stop + start for one slot.
- `request-restart-runtime-slot.ps1`: delayed detached restart used by the MCP `runtime_restart` tool.
- `write-runtime-profiles.ps1`: generates A/B profiles under `.p05/tunnel/profiles`.
- `run-operator.ps1`: starts Operator directly, without Task Scheduler.
- `open-operator.ps1`: ensures Operator is running and opens the browser.

Optional host-task helpers may still provision `P05-Runtime` and
`P05-Operator` for manual/on-demand host integration, but current P05 does not
install or require a RestartBroker task. Runtime restart uses the repo-local
slot scripts above.

`uninstall-host-tasks.ps1` also removes the historical
`P05-RestartBroker` name as upgrade cleanup for older installations.

The legacy names `run-runtime.ps1`, `run-runtime-b.ps1` and
`restart-runtime.ps1` are thin wrappers around the slot scripts.

## Secrets

`.env` and the complete `.p05/` tree are Git-ignored. The tunnel profiles store
`env:CONTROL_PLANE_API_KEY`, not the key value itself.

For fresh installs, `bootstrap.ps1` stores the supplied key in the local
Git-ignored `.env`. Do not commit or share that file.

## Legacy cleanup

Older installations may still have:

- `D:\Tools\...`
- `D:\Project_Git\_p05_deploy`
- tunnel-client profiles under the user profile
- `P05-Runtime`, `P05-Operator`, or RestartBroker Scheduled Tasks

The repo-local runtime does not require them. Do not delete legacy paths until the
repo-local A/B and Operator have been validated on that machine. Cleanup is a
separate host-level action.
