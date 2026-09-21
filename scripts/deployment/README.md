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

The script securely prompts for:

1. Tunnel ID A
2. Tunnel ID B
3. OpenAI control-plane API key

By default the outer authorization root is the P05 repository itself. An explicit
larger authorization perimeter can be supplied with `-AllowedRoots`.

Bootstrap:

- downloads pinned Node.js and tunnel-client releases;
- verifies SHA-256 checksums from their published checksum manifests;
- installs them into `.p05/tools`;
- creates the Git-ignored machine-local `.env`;
- runs `npm ci` and `npm run build`;
- creates repo-local A/B tunnel profiles;
- creates separate A/B state directories;
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

- Runtime A controls `@Boonray-A`.
- Runtime B controls `@Boonray-B`.
- Each Runtime has independent start/stop/restart and Workspace binding.
- Closing Operator does not stop A or B.
- Restarting A does not affect B, and vice versa.

Runtime state is persistent under `.p05/runtime-a/state` and
`.p05/runtime-b/state`. Workspace bindings survive Runtime restart.

## Runtime scripts

- `launch-runtime.mjs`: one shared P05 launcher; receives slot A or B.
- `run-runtime-slot.ps1`: starts one repo-local tunnel/runtime.
- `stop-runtime-slot.ps1`: stops only the selected slot and its child P05 process.
- `restart-runtime-slot.ps1`: stop + start for one slot.
- `request-restart-runtime-slot.ps1`: delayed detached restart used by the MCP `runtime_restart` tool.
- `write-runtime-profiles.ps1`: generates A/B profiles under `.p05/tunnel/profiles`.
- `run-operator.ps1`: starts Operator directly, without Task Scheduler.
- `open-operator.ps1`: ensures Operator is running and opens the browser.

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
