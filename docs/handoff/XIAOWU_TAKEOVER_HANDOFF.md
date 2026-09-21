# XiaoiWu Local Agent Handoff — Restore P05 and Hand Control to ChatGPT

目标：在“小悟”本地 Windows 机器上同步当前 P05 V2 代码，恢复**小悟原有 tunnel**，启动 P05 MCP（developer profile，仅授权 P05 自身工作区），然后停手，让 ChatGPT 从现有 `P05_Remote_Agent` Connector 接管。

这不是 V3 部署。只使用 `feat/v2-operator-console`。

## 0. 强制规则

- 不复制 Boonray 的 `.env`、`.p05/device.json`、tunnel id、alias、profile 或任何 API key。
- 优先复用小悟现有 tunnel。现有 ChatGPT Connector 指向原 tunnel；新建 tunnel 不会自动让它上线。
- 不把 `CONTROL_PLANE_API_KEY`、Bearer/token、`.env` 内容输出到聊天或 Git。
- 不执行 `git reset --hard`，不删除未知本地改动。
- 如果 repo 脏，先 `git stash push -u -m "XiaoiWu pre-handoff backup"`。
- 本次 bootstrap 不安装/修改 Windows Scheduled Task。
- 不直接运行当前 `scripts/deployment/run-runtime.cmd` 或 `restart-runtime.ps1`；它们当前仍带 Boonray 侧运行参数，待 ChatGPT 接管后再机器中立化/适配小悟。
- 不切换到 `wip/v3a-paused` 作为运行基线。

## 1. Git 目标

Repo:

`https://github.com/YanfengSong/P05_Remote_Agent.git`

运行分支:

`feat/v2-operator-console`

必须到达 commit:

`a477c2e18ce9dacfc8ee7b54b336dd6c1f49d55e`

V3-A 仅备份，不运行:

`wip/v3a-paused` @ `06cd3d96c24953697f5d289e333d400e63bdc4f7`

## 2. 先做本机发现，不修改

PowerShell（普通用户）：

```powershell
hostname
Get-Command node.exe -ErrorAction SilentlyContinue
node --version
npm --version
Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
```

如果 tunnel-client 不在 PATH，搜索常见位置：

```powershell
Get-ChildItem D:\Tools,C:\Tools,$env:LOCALAPPDATA,$env:APPDATA `
  -Filter tunnel-client.exe -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 20 FullName
```

找到后：

```powershell
$Tunnel = '<tunnel-client.exe 绝对路径>'
& $Tunnel --version
& $Tunnel profiles list
& $Tunnel runtimes list --json
```

重点查找小悟现有 alias/profile/tunnel，例如 `p05-xiaoiwu`，或名称/description 明显属于 XiaoiWu/P05 的须。

如果有 alias：

```powershell
& $Tunnel runtimes status <xiaoiwu-alias> --json
```

### 必须记录的非敏感证据

- hostname
- repo 路径
- Node 路径/version
- tunnel-client 路径/version
- XiaoiWu alias
- XiaoiWu profile 名/路径
- XiaoiWu tunnel id

如果找不到原 tunnel identity，立即停手并报告：

`BLOCKED: existing XiaoiWu tunnel identity not found`

不要创建新 tunnel。

## 3. 同步代码

如果已有 repo：

```powershell
cd <repo>
git status --short --branch
```

如果脏：

```powershell
git stash push -u -m "XiaoiWu pre-handoff backup"
```

然后：

```powershell
git fetch origin
git switch feat/v2-operator-console
git pull --ff-only
git rev-parse HEAD
```

HEAD 必须等于：

`a477c2e18ce9dacfc8ee7b54b336dd6c1f49d55e`

如果没有 repo：

```powershell
git clone https://github.com/YanfengSong/P05_Remote_Agent.git <repo>
cd <repo>
git switch feat/v2-operator-console
git rev-parse HEAD
```

## 4. 保留小悟机器身份和本地状态

检查：

```powershell
Test-Path .env
Test-Path .p05\device.json
```

如果存在：
- 保留原文件。
- 不用 Git 或别的机器覆盖。
- 不输出 secret 内容。
- `.p05/device.json` 必须保持小悟自己的 device identity。

如果 `.p05/device.json` 不存在，可以让 P05 首次启动后自己创建。

## 5. 配置最小授权范围

初始接管只授权 P05 自身 repo，不授权整盘，也不添加业务项目。

如果 repo 是 `D:\Project_Git\P05_Remote_Agent`，推荐 `.env` 至少包含：

```dotentjREMOTE_AGENT_ALLOWED_ROOTS=D:\Project_Git\P05_Remote_Agent
REMOTE_AGENT_DEFAULT_CWD=D:\Project_Git\P05_Remote_Agent
P05_WORKSPACES_JSON=[{"id":"p05","root":"D:\\Project_Git\\P05_Remote_Agent","kind":"platform-source"}]
P05_ACTIVE_WORKSPACE_ID=p05
P05_TOOL_PROFILE=developer
MATLAB_MCP_ENABLED=false
P05_OPERATOR_TUNNEL_ALIAS=p05-xiaoiwu
```

如果 repo 路径不同，按真实路径替换并正确 JSON escape。

不要新增兞它 workspace。等 ChatGPT 接管后再按用户授权添加。

## 6. 检查 Runtime API key 是否存在，但绝不打印

```powershell
if ($env:CONTROL_PLANE_API_KEY) {
  'CONTROL_PLANE_API_KEY present in process env'
} else {
  'not in process env'
}

$k = Get-ItemProperty -Path 'HKCU:\Environment' `
  -Name 'CONTROL_PLANE_API_KEY) -ErrorAction SilentlyContinue

if ($k -and $k.CONTROL_PLANE_API_KEY) {
  'CONTROL_PLANE_API_KEY present in HKCU environment'
} else {
  'not in HKCU environment'
}
```

如果只在 HKCU：

```powershell
if (-not $env:CONTROL_PLANE_API_KEY -and $k) {
  $env:CONTROL_PLANE_API_KEY = [string]$k.CONTROL_PLANE_API_KEY
}
```

如果两处都没有，立即停手并要求 operator 在小悟本机安全配置 Runtime API key。不要让用户把 key 粘到聊天里。

## 7. Build

在 repo：

```powershell
npm ci
npm run check
npm run build
Test-Path .\dist\index.js
```

全部必须成功，最后应为 `True`。

可再运行：

```powershell
npm run verify
```

如果 `verify` 因明确的 host-specific 前置条件失败，可以保留输出；但 `check/build` 不能失败。

## 8. 检查原小悟 tunnel/profile

```powershell
& $Tunnel runtimes list --json
& $Tunnel profiles list
& $Tunnel runtimes status <xiaoiwu-alias> --json
& $Tunnel doctor --profile <xiaoiwu-profile> --explain
```

决策顺序：

1. 已有 native runtime 已正确指向当前 `dist/index.js`：直接复用。
2. 已有 profile 仍指向旧 `127.0.0.1:8765/mcp`：保留原 tunnel id，但把本地 runtime 绑定改成当前 stdio MCP。
3. 不创建新的远端 tunnel。

## 9. 把“原小悟 tunnel”连接到当前 P05 stdio MCP

目标 MCP 命令：

```text
node --env-file-if-exists=<repo>\.env <repo>\dist\index.js
```

设变量：

```powershell
$Repo = '<P05 repo 绝对路径>'
$Node = (Get-Command node.exe).Source
$Alias = '<原 XiaoiWu alias>'
$Profile = '<原 XiaoiWu profile，或 p05-xiaoiwu>'
$TunnelId = '<原 XiaoiWu tunnel id>'
$McpCommand = "$Node --env-file-if-exists=$Repo\.env $Repo\dist\index.js"
```

然后使用**原 XiaoiWu tunnel id**：

```powershell
& $Tunnel runtimes connect `
  --alias $Alias `
  --tunnel-id $TunnelId `
  --runtime-api-key env:CONTROL_PLANE_API_KEY `
  --mcp-command $McpCommand `
  --profile $Profile
```

禁止替换成 Boonray 的 alias/tunnel id/profile。

如果 runtime 已经在跑，不要启动重复实例，改为检查 status。

## 10. 本地验证

```powershell
& $Tunnel runtimes status $Alias --json
$info = & $Tunnel runtimes list --json | ConvertFrom-Json
$entry = $info.aliases |
  Where-Object { $_.alias -eq $Alias } |
  Select-Object -First 1
$base = (Get-Content $entry.health_url_file -Raw).Trim()

Invoke-WebRequest "$base/healthz" -UseBasicParsing
Invoke-WebRequest "$base/readyz" -UseBasicParsing
```

期望：

```text
/healthz -> 200
/readyz  -> 200
```

检查 runtime 日志，确认 P05 tool profile 是：

`developer`

应能看到 developer surface，而不只是 discovery 的 `device_info/ping`。例如应包含：

- `fs_read`
- `fs_write`
- `git_status`
- `shell_run`
- `command_run`

不要把原始 secret/log 中的 credential 发到聊天。

## 11. 这里停止，不做 Host 持久化

此时不要：
- 安装 `P05-Runtime`
- 安装/修改 `P05-RestartBroker`
- 配置 Operator Console 开机启动
- 运行 Boonray-specific deployment script
- 添加其它 workspace
- 切换到 V3-A

立即转入 handoff 完成汇报。

## 12. 给 operator 的完成汇报模板

只汇报非敏感字段：

```text
XIAOWU_HANDOFF_READY

hostname: <hostname>
repo: <absolute repo path>
branch: feat/v2-operator-console
commit: a477c2e18ce9dacfc8ee7b54b336dd6c1f49d55e
node: <version + path>
tunnel_client: <version + path>
tunnel_alias: <xiaoiwu alias>
tunnel_profile: <xiaoiwu profile>
tunnel_id: <xiaoiwu tunnel id>
health: 200
ready: 200
p05_profile: developer
device_identity: preserved | newly-created
blockers: none
```

绝不包含 API key/token/.env 内容。

然后告诉用户：

`请回 ChatGPT 说：小悟 handoff ready，请接管。`

## 13. ChatGPT 接管判据

用户说 handoff ready 后，ChatGPT 会先调用现有 XiaoiWu Connector：

- `device_info`
- `ping`

成功条件：
- 不再出现 `Tunnel-client has not been seen`；
- hostname 是小悟，不是 Boonray；
- XiaoiWu device id 稳定［
- status=online。

随后 ChatGPT 会：
1. 检查 live tool surface；
2. 验证 developer tools［
3. 检查 XiaoiWu repo/机器状态［
4. 把 Operator Console 和 deployment script 适配成 XiaoiWu 自己的 alias/profile/path［
5. 需要 Windows Scheduled Task 等主机级变更时，再向 operator 明确请求授权；
6. 继续 V2 工作。

如果 tunnel 已 online 但 ChatGPT 仍只看到 `device_info/ping`，不要新建 tunnel、不要重装。报告：

`connector online, tool surface appears stale`

然后由 ChatGPT 侧处理 connector/tool refresh。

## 14. 立即停止的条件

遇到以下任一情况就停止并汇报 blocker：

- 找不到原 XiaoiWu tunnel id［
- Runtime API key 缺失；
- Git 无法到指定 branch/commit；
- `npm run check` 或 `npm run build` 失败；
- tunnel doctor 有未解决的 auth/control-plane 错误；
- health/ready 长时间不能 200；
- 需要复制 Boonray identity/secret；
- 需要删除/reset 未知本地工作；
- Windows 要求新的 host-level 权限。

最终 DoD：**现有 XiaoiWu ChatGPT Connector 能从云端重新访问。**
