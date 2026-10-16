# P05 Repo-local Deployment

P05 is deployed from one Git repository. The committed repository is the single
source of truth for GUI, backend logic, policy, plugins, tests and deployment scripts.

Machine-local binaries, credentials, tunnel profiles, logs, runtime state and workspace
bindings live under `<repo>/.p05` or the Git-ignored `.env`. They are deliberately
not copied between computers.

## Universal deployment contract

The following are identical on every machine when the same Git commit is deployed:

- Operator Console GUI and control behavior;
- P05 Core MCP tools, policy and permission semantics;
- Runtime lifecycle and A/B slot behavior;
- Workspace and Reference Root authorization rules;
- Plugin framework and downstream binding rules;
- Audit / Recovery behavior;
- pinned Node.js and tunnel-client bootstrap versions;
- automated verification suites.

The following are intentionally machine-specific:

- `REMOTE_AGENT_ALLOWED_ROOTS` and optional workspace roots;
- Device ID, generated locally under `.p05/device.json`;
- OpenAI Tunnel ID(s);
- `CONTROL_PLANE_API_KEY`;
- ChatGPT connector display names;
- local MATLAB / Simulink installation and credentials;
- local proxy/network settings.

**Do not copy another host's `.env`, `.p05`, Device ID, Tunnel ID,
API key, OAuth client secret or runtime state to another computer.** The target is
behavioral and code-level parity, not shared machine identity.

## Fresh machine

Supported deployment target for the current V2 path:

- Windows x64;
- Git;
- PowerShell;
- outbound HTTPS access to the required package/control-plane endpoints.

Node.js and tunnel-client are installed by Bootstrap into the repository-local
`.p05/tools` directory. The current validated Node target is 22.23.1 and the
current validated tunnel-client target is 0.0.14; do not change either only for
portability without rerunning the full validation. Node publishes a Windows x64 binary for 22.23.1.
The tunnel-client v0.0.14 release is the currently validated multi-replica rollout
target used by this repository.

### Install

Clone the repository and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Bootstrap asks for:

1. Runtime topology: A only (default) or A+B;
2. Tunnel ID for each configured Runtime;
3. OpenAI control-plane API key.

It derives all repository paths from the location of `bootstrap.ps1`. By default,
the P05 repository itself becomes the single `platform-source` Workspace. If a
larger authorization perimeter is required, pass `-AllowedRoots` explicitly.

Bootstrap then performs PreInstall/PostInstall checks, installs the pinned local
toolchain when necessary, runs `npm ci`, builds the project, generates the Runtime
profiles, and leaves the Runtime and Operator stopped unless `-SkipCoreStart` is
omitted (the default starts configured Runtime slots).

For a normal deployment, the only values that must be different from another
machine are the machine-local roots, tunnel identities, connector names and
credentials.

## Daily operation

Run:

```text
P05-Operator.cmd
```

The Operator Console is bound to loopback and is started with the repository-local
Node executable. The GUI is generated from the same committed `src/operator/ui.ts`
on every host.

Runtime A and B use the same `dist/index.js` and the same launcher. Each slot has
independent state, audit, workspace binding, tunnel profile and restart lifecycle.

## Verification

Read-only deployment preflight:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deployment\preflight.ps1
```

Universal deployment contract check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deployment\test-universal.ps1
```

Full repository verification:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

The verification pipeline uses the repository-local Node/npm installed by Bootstrap,
so a machine does not need a globally installed Node.js toolchain.

## Connector / Tunnel onboarding

A Tunnel ID is a connection identity, not part of the application source code.
Each physical computer should normally have its own Tunnel ID(s), even though the
Runtime implementation is identical.

The control-plane API key is supplied to the runtime through the Git-ignored local
`.env`. Bootstrap writes tunnel profiles that reference the environment variable
rather than embedding the secret in the profile.

The ChatGPT connector name is also external configuration. Set
`P05_RUNTIME_A_CONNECTOR` and `P05_RUNTIME_B_CONNECTOR` to the actual connector
names used on that machine. The application code does not contain host-specific
connector names.

## Workspace model

The platform Workspace is always the repository containing the deployed P05 build.
Business Workspaces are optional and can be registered from the Operator Console.

A Workspace ID is portable; its filesystem path is not. Therefore a fresh machine
must bind its own local project directory rather than importing another host's
absolute path.

Structured file/Git operations remain inside the active Workspace. Platform
validation remains bound to the platform Workspace. Reference Roots are separately
authorized and remain read-only.

## Optional applications

MATLAB / Simulink is an application plugin. Its code and capability contracts are
shared by all deployments, but the actual MATLAB installation, session and tool
availability are host-local.

The same rule applies to future engineering application plugins: code and policy
come from Git; application installation and credentials stay on the host.

## Legacy helpers

`scripts/start-local.ps1` and optional Scheduled Task helpers are compatibility /
diagnostic paths. The canonical V2 deployment path is:

```text
bootstrap.ps1
    -> repo-local Node + npm + tunnel-client
    -> generated Runtime profiles
    -> P05-Operator.cmd
    -> Runtime A/B
```

Do not use legacy host-specific deployment directories as part of a fresh install.
They are not required by the repo-local runtime.
