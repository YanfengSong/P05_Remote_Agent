# Isolation inventory and enforcement gate

Status: **production execution backend UNAVAILABLE**. This module implements read-only host inventory and a fail-closed requirement gate. It does not implement an isolated process runner. It does not change the existing explicitly authorized `trusted-host` Process Host into an isolated backend.

## Contract

`createSystemIsolationHostAdapter()` provides a Windows inventory probe. It runs a fixed, bounded PowerShell query without starting Docker, WSL distributions, services or optional Windows features. A feature query denied for insufficient OS privileges is `UNVERIFIED`, not `DISABLED`. Non-Windows inventory is not yet implemented and fails closed.

`createIsolationBackend(adapter?)` provides:

- `probe(): Promise<IsolationReport>`: platform facts and candidate descriptors with the dimensions required by technical solution §10.1: filesystem/network enforcement, principal isolation, process-tree control, secret delivery, read-only references and reattachment.
- `require(requirements): Promise<never>`: rejects with `IsolationUnavailableError.code === "ISOLATION_BACKEND_UNAVAILABLE"` before any dispatch. Even a successful inventory with every executable present cannot grant isolation. No remote input, approval, adapter inventory or security-mode string can activate a missing implementation.

All candidate descriptors currently return `availability: "UNAVAILABLE"`; enforcement dimensions remain `unverified`, and `actualSecurityMode` is null. The module has no command-spawn interface and no automatic `trusted-host` fallback. The local HostAdapter is a trusted dependency, never a caller-supplied MCP object.

## Recorded host experiment, 2026-09-29

| Candidate | Observation | Consequence |
|---|---|---|
| Windows Sandbox | Windows 11 Home, build 26200; executable absent; hypervisor present | No usable Windows Sandbox backend. Optional-feature inspection requires OS elevation and was not escalated to administrator. |
| AppContainer | `userenv.dll` exists; no `mxc` or `runinappcontainer` command found | API presence is not a restricted token, policy or installed P05 runner. Native launcher and policy still required. |
| Docker | CLI 29.5.3 present; existing `desktop-linux` daemon pipe absent | Daemon unavailable; no image availability asserted. No service started, image pulled or container created. |
| WSL | Ubuntu already running on WSL2; docker-desktop stopped | WSL itself is not an isolation boundary for P05. No stopped distribution was started. |
| bubblewrap in Ubuntu | 0.11.1; uid 1000; kernel `6.18.33.2-microsoft-standard-WSL2` | A temporary Linux namespace experiment was feasible without installation or system configuration changes. |

The explicit `--wsl-poc Ubuntu` experiment creates only a new `p05-isolation-poc-*` Linux temporary directory, then removes it. It uses `--unshare-all --unshare-user --disable-userns`, drops capabilities, clears the environment, creates fresh proc/dev/tmp mounts, binds only its new Workspace writable, and binds its new Reference and Runner directories read-only. Linux `/usr` is mounted read-only solely to provide the existing Python runtime. It never binds Windows drives, Core state, credentials, Docker sockets or the existing project. CPU/address-space/file-size limits and bounded subprocess timeouts contain this fixed test; these are not a complete production process-tree budget.

The real negative tests passed:

- Writing the temporary Workspace succeeds; reading Reference succeeds.
- Writing Reference and Runner files is refused and their parent-side content is unchanged.
- A Workspace symlink to the unmounted temporary outside secret cannot be read; the secret remains unchanged.
- `/mnt/c`, `/init` and the usual WSL interop paths are absent; P05/WSL environment variables are absent.
- `NoNewPrivs=1`, effective capabilities are zero, and network namespace identity differs from the parent.
- Only loopback exists inside the namespace. Connecting to the parent's ephemeral loopback listener fails, while the parent positive control connects successfully.
- A real child Python process inherits the mount boundary.

The first experimental command failed before running the payload because bubblewrap requires explicit `--unshare-user` with `--disable-userns`; the corrected command added that requirement. Protection was not relaxed. The final experiment and TypeScript compilation passed.

These observations validate only the specific temporary Linux boundary. They do **not** close P04/P05, certify Windows execution, prove generic WSL escape resistance, or activate an execution backend.

## Remaining work before an available backend

1. Select and pin a maintained launcher/runtime; install it into a protected location with a verified manifest. Bind actual distro/OS identity, Workspace roots and immutable policy to a trusted adapter. Do not invoke private Codex helpers as an assumed public API.
2. Address Linux runtime/reference exposure, symlink/hardlink races, inherited descriptors, Windows PE/binfmt/interop escape attempts, namespace escape and descendants. The current experiment tests hidden paths, not arbitrary PE binaries or a complete syscall attack surface.
3. Implement cgroup/owned-process-tree CPU, memory and PID budgets, cancellation, output limits and crash cleanup; integrate durable dispatch keys, receipts and reattachment with the Execution Host. Process groups alone do not prove escape prevention.
4. Validate actual secret delivery and removal of host state/credentials. Arbitrary files under `/usr` cannot silently become approved references in a production adapter.
5. Test real Git/Node/tool compatibility. A Linux worker does not execute native Windows MATLAB or engineering tools; those require a separately validated Windows backend or explicit `trusted-host` authorization.
6. Network `none` is the only tested policy. DNS/domain allowlists, proxies, redirected endpoints and hardware access remain unsupported until separately enforced and tested.

For Docker, the next prerequisite is an explicitly available daemon and a locally pinned image. A future experiment must set network none, read-only root, drop all capabilities, no-new-privileges and CPU/memory/PID budgets, mount only the new permitted Workspace, and prohibit the Docker socket and host secrets. Starting/installing these dependencies is provisioning work, not something this probe performs.

## Reproduction

From the isolated development checkout:

```text
rtk proxy node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --rootDir src --outDir dist --strict --esModuleInterop --skipLibCheck --types node src/test/v3-isolation.ts
rtk proxy node dist/test/v3-isolation.js
rtk proxy node dist/test/v3-isolation.js --wsl-poc Ubuntu
```

The last command is optional and requires the explicitly named distribution to already be running and to have `/usr/bin/python3` and `/usr/bin/bwrap`. It installs nothing. Failure remains failure and leaves production availability UNAVAILABLE.

## Primary references

- [Windows Sandbox overview](https://learn.microsoft.com/en-us/windows/security/threat-protection/windows-sandbox/windows-sandbox-overview): Windows Home is unsupported. Supported editions/features still require explicit provisioning and policy validation.
- [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) and [launching an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer): restricted execution requires a real token/capability boundary; presence of a DLL is insufficient.
- [bubblewrap official repository](https://github.com/containers/bubblewrap): a low-level namespace construction tool whose security depends on the configured policy, not a complete ready-made P05 sandbox.
- [WSL filesystem and interoperability documentation](https://learn.microsoft.com/en-us/windows/wsl/filesystems): WSL normally exposes mounted Windows filesystems and can invoke Windows programs with the active Windows user's permissions.
- [OpenAI Codex](https://github.com/openai/codex): the existing technical solution's engineering reference; not an assumed stable distribution contract for internal helpers.

This record implements the honest unavailable path required by technical solution §9, §10 and §31. P04/P05 remain open until a production adapter passes their full acceptance criteria.
