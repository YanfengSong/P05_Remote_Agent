# P05 Universal Tool — New Chat Handoff

> Date: 2026-09-21
> Scope: V2 only. V3/V3-A remains paused unless the user explicitly resumes it.

## 1. Project / Git

Repository:

```text
https://github.com/YanfengSong/P05_Remote_Agent.git
```

Active branch:

```text
feat/v2-operator-console
```

Current remote HEAD:

```text
357fffbccdcfb03731f48d696f0ecfd77d78529b
fix: stabilize universal P05 host state
```

Recent commits:

```text
357fffb fix: stabilize universal P05 host state
bc5db3f fix: make restart broker and proxy host-configurable
55a3c2a feat: add machine-neutral host deployment
2318d7e docs: add detailed XiaoiWu takeover manual
aee77db docs: add XiaoiWu remote takeover handoff
a477c2e feat: add V2 operator console and runtime observability
74fcb19 feat: establish P05 engineering agent foundation baseline
```

Important docs:

```text
scripts/deployment/README.md
docs/handoff/XIAOWU_TAKEOVER_MANUAL.md
docs/handoff/XIAOWU_TAKEOVER_HANDOFF.md
docs/architecture/PERMISSION-MODEL.md
docs/architecture/TARGET_ARCHITECTURE_V3.md
docs/research/V3_TECHNICAL_RESEARCH.md
```

Do NOT use or resume:

```text
wip/v3a-paused
```

unless the user explicitly asks to resume V3.

---

## 2. User intent

The user wants P05 to become a reusable general-purpose local engineering tool:

```text
one repository
+ one deployment architecture
+ machine-local configuration
+ reusable on multiple Windows PCs
```

The target is Remote Desktop Commander-like engineering ergonomics, but with explicit Workspace, policy, lifecycle, audit, plugin and host-deployment boundaries.

Current priority is V2 stabilization/generalization, not V3.

---

## 3. Authorization / safety boundary

The user has explicitly established:

```text
Inside an authorized Workspace:
  P05 may read/write/build/test/git without asking every step.

Outside the authorized Workspace:
  persistent modifications require explicit user approval.
```

Current P05 platform workspace on Boonray:

```text
D:\Project_Git\P05_Remote_Agent
```

Current P05 platform workspace on XiaoWu:

```text
F:\Project_Git\P05_Remote_Agent
```

Host-level Windows Scheduled Task installation/modification is outside-workspace persistent state and normally requires approval.

The user already explicitly approved full P05 host deployment for:
- XiaoWu
- Boonray

Do not silently expand business workspaces or authorize whole drives.

Core rule:

```text
Self-development is allowed.
Self-authorization is not.
```

---

## 4. Current universal host deployment architecture

Source-controlled deployment files:

```text
scripts/deployment/
  README.md
  common.ps1
  install-host-tasks.ps1
  uninstall-host-tasks.ps1
  run-runtime.ps1
  run-runtime.cmd
  restart-runtime.ps1
  run-operator.ps1
```

Other relevant files:

```text
scripts/start-operator.ps1
scripts/install-restart-broker.ps1
src/operator/runtime-control.ts
src/tools/runtime.ts
src/state.ts
.env.example
```

Universal deployment behavior:

- Node path comes from machine-local `.env` or PATH.
- tunnel-client path comes from machine-local `.env` or PATH/repo discovery.
- tunnel alias is machine-local.
- profile/tunnel id/health metadata are resolved from tunnel-client runtime metadata.
- proxy settings are machine-local.
- restart broker name is machine-local and validated.
- device state no longer depends on process cwd.
- default state dir is anchored to `<repo>/.p05`.
- `P05_STATE_DIR` may still be set explicitly.
- Runtime API key never goes into Git.
- `.env` and `.p05` are git-ignored.

Scheduled task model:

```text
P05-Runtime
  login trigger
  source-controlled action: scripts/deployment/run-runtime.ps1

P05-Operator
  login trigger
  source-controlled action: scripts/deployment/run-operator.ps1

P05-RestartBroker (default)
or machine-local override such as P05-RestartBroker-V2
  no automatic trigger
  source-controlled action: scripts/deployment/restart-runtime.ps1
```

Operator Console:

```text
http://127.0.0.1:56301
```

It binds loopback only.

---

## 5. Boonray current state

Connector namespace:

```text
mcp__Boonray__*
```

Machine:

```text
hostname: Boonray5CD6065Z9H
repo: D:\Project_Git\P05_Remote_Agent
branch: feat/v2-operator-console
HEAD: 357fffbccdcfb03731f48d696f0ecfd77d78529b
deviceId: p05-7058c499-45e4-4294-b05b-aae1562ed838
agentVersion: 0.3.1
status: online
```

Current stable machine-local state:

```text
P05_STATE_DIR=D:\Project_Git\P05_Remote_Agent\.p05
P05_NODE_PATH=D:\Tools\node-v22.23.1-win-x64\node.exe
P05_TOOL_PROFILE=developer
P05_OPERATOR_TUNNEL_ALIAS=p05-boonray
P05_OPERATOR_RUNTIME_TASK=P05-Runtime
P05_OPERATOR_RESTART_TASK=P05-RestartBroker-V2
P05_OPERATOR_TASK=P05-Operator
P05_OPERATOR_PORT=56301

CONTROL_PLANE_HTTP_PROXY=http://127.0.0.1:7892
HTTPS_PROXY=http://127.0.0.1:7892
HTTP_PROXY=http://127.0.0.1:7892
```

Do not print the Runtime API key. It is present in HKCU environment.

Boonray runtime identity:

```text
alias: p05-boonray
profile: p05-boonray5cd6065z9h
tunnel id: tunnel_6aaf525bd7b88191a7e7325dd56b218b
tunnel-client: D:\Tools\tunnel-client\tunnel-client.exe
```

Current tasks:

```text
P05-Runtime
  -> D:\Project_Git\P05_Remote_Agent\scripts\deployment\run-runtime.ps1
  login trigger

P05-Operator
  -> D:\Project_Git\P05_Remote_Agent\scripts\deployment\run-operator.ps1
  login trigger

P05-RestartBroker-V2
  -> D:\Project_Git\P05_Remote_Agent\scripts\deployment\restart-runtime.ps1
  no trigger
```

Legacy task still exists:

```text
P05-RestartBroker
  -> D:\Project_Git\_p05_deploy\44_restart_runtime.ps1
```

It is historical compatibility only. New P05 uses `P05-RestartBroker-V2`.
Do not weaken Windows ACLs or bypass UAC to replace/delete the legacy task.

Verified on Boonray:

- GUI restart:
  - Operator PID stayed alive.
  - MCP PID changed.
  - action waiting -> succeeded.
  - Tunnel returned ready.
  - Bridge returned online.
- deviceId remained the original repo identity after restart.
- proxy settings restored control-plane connectivity.
- runtime state returned:
  `process_running=true`
  `runtime_state=ready`
  `remote_error=""`.

Important bug fixed:

Previously `src/state.ts` used:

```text
process.cwd()/.p05
```

This caused a new device identity when P05 was manually launched from `C:\Users\EDY`.

Now default state is anchored to:

```text
<repo>/.p05
```

independent of cwd.

There may still be a stray historical file:

```text
C:\Users\EDY\.p05\device.json
```

created during the bad launch. It is outside the workspace. Do not delete it without explicit user approval.

---

## 6. XiaoWu current state

Connector namespace:

```text
mcp__XiaoWu__*
```

Known machine data from completed deployment:

```text
hostname: XiaoWu
repo: F:\Project_Git\P05_Remote_Agent
branch: feat/v2-operator-console
deviceId: p05-1362e78d-db4d-4296-acb1-62c330dfae98
node: F:\nodejs\node.exe
tunnel-client:
  F:\Project_Git\P05_Remote_Agent\tunnel-client-v0.0.14-windows-amd64\tunnel-client.exe
alias: p05-xiaoiwu
profile: p05-xiaoiwu
tunnel id: tunnel_6aafdf5a50dc81919b3823391f41e6ea
```

XiaoWu was previously fully deployed with:

```text
P05-Runtime
P05-Operator
P05-RestartBroker
```

all pointing to repo-local deployment scripts.

Previous XiaoWu runtime restart acceptance passed:

- Operator survived.
- MCP PID changed.
- runtime ready.
- Connector developer surface available.
- 23 developer tools visible.

However, at handoff creation time XiaoWu is CURRENTLY OFFLINE from ChatGPT:

```text
Tunnel-client has not been seen for 300 seconds.
```

Therefore the new chat must NOT assume XiaoWu is online.

First action for XiaoWu:
- call `mcp__XiaoWu__ping`
- call `mcp__XiaoWu__device_info`

If offline, determine whether the PC is asleep/off or the tunnel task failed. Do not create a new tunnel unless the old tunnel is confirmed unusable and the user approves.

XiaoWu may still be on an older commit than `357fffb`; once online, sync it to the current branch and rerun deployment verification.

---

## 7. Current Git state

At handoff creation:

Boonray:

```text
branch: feat/v2-operator-console
local HEAD: 357fffbccdcfb03731f48d696f0ecfd77d78529b
remote HEAD: 357fffbccdcfb03731f48d696f0ecfd77d78529b
working tree: clean
```

Do not assume XiaoWu is at the same commit until it is online and checked.

---

## 8. Validation status

Latest important validation behavior:

```text
POLICY_PROFILES_OK        240 checks
PROFILE_EXPOSURE_OK       161-162 checks
TEMP_READONLY_OK           49 checks
FOUNDATION_OK              35 checks
GIT_MUTATIONS_OK           13 checks
PLUGIN_FRAMEWORK_OK        17 checks
OUTPUT_SCHEMA_OK           71 checks
OPERATOR_CONSOLE_OK        16 checks
DOWNSTREAM_SMOKE_OK        PASS
```

The 161/162 difference is host-dependent:
- Boonray NTFS volume supports the 8.3 short-name probe -> 162
- XiaoWu volume previously skipped that probe -> 161

Therefore the universal baseline is:
- minimum 602 explicit checks
- 603 when the 8.3 short-name probe is available

A test isolation improvement was added:
`profile-exposure` uses its own state fixture rather than production `.p05`.

---

## 9. First actions in the new chat

Do these in order:

1. Verify Boonray:
   - `mcp__Boonray__ping`
   - `mcp__Boonray__device_info`
   - `mcp__Boonray__git_status`

2. Verify XiaoWu:
   - `mcp__XiaoWu__ping`
   - `mcp__XiaoWu__device_info`

3. If XiaoWu is online:
   - inspect Git HEAD/status;
   - sync to `origin/feat/v2-operator-console` at or after `357fffb`;
   - preserve XiaoWu local `.env` and `.p05`;
   - rebuild;
   - rerun `install-host-tasks.ps1`;
   - verify restart and Operator Console;
   - verify deviceId remains XiaoWu original identity.

4. If XiaoWu is offline:
   - do not create a new tunnel by default;
   - inspect/recover the existing `p05-xiaoiwu` deployment once the host is reachable;
   - keep the existing tunnel identity unless the control plane says it no longer exists.

5. Keep V3 paused.

---

## 10. Remaining cleanup / next engineering work

Priority order:

1. XiaoWu sync/acceptance against `357fffb`.
2. Confirm both machines survive real Windows logoff/reboot and automatically restore:
   - Runtime
   - Tunnel
   - Operator Console
3. Decide whether the old Boonray external compatibility directory:
   `D:\Project_Git\_p05_deploy`
   can be retired.
   This is outside the workspace and requires explicit user approval before deletion.
4. Decide whether the legacy Boonray `P05-RestartBroker` task should be removed.
   Host-level persistent change; ask before removing unless current approval clearly covers cleanup.
5. Improve Operator Console UI/observability only within V2.
6. Do not resume V3 implementation unless user explicitly asks.

---

## 11. Important operational lessons

- `healthz=200` / `readyz=200` alone do NOT prove the remote tunnel is connected.
- Always check:
  - `process_running=true`
  - `runtime_state=ready`
  - `remote != null`
  - `remote_error=""`
- Proxy is host configuration, not source code.
- Runtime API key is host secret, never Git.
- Tunnel id/profile/alias remain machine identity/configuration.
- P05 default state must never depend on process cwd.
- Connector tool-surface staleness is a ChatGPT-side issue; do not rebuild tunnels just because tools are stale.
- Old tunnel IDs that return 404 should not be silently reused.
- Never copy Boonray identity/secrets to XiaoWu or vice versa.

---

## 12. New-chat instruction

Paste this into the new chat:

```text
继续 P05_Remote_Agent 项目。先读取并严格按照仓库里的
docs/handoff/P05_UNIVERSAL_TOOL_HANDOFF_2026-09-21.md
接手。

Git:
https://github.com/YanfengSong/P05_Remote_Agent.git

branch:
feat/v2-operator-console

current remote baseline:
357fffbccdcfb03731f48d696f0ecfd77d78529b

先验证 Boonray 和 XiaoWu 的实时连接、Git HEAD、任务状态，不要假设 XiaoWu 在线。
V3/V3-A 继续暂停，只做 V2 通用 P05 的稳定化和双机一致性。
遵守权限边界：当前授权 Workspace 内可以直接开发；Workspace 外持久修改需明确批准，除非本轮已有明确授权。
```
