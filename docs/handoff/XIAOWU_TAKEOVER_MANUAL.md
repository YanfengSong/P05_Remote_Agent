# 小悟接管 P05 — 详细操作手册

目标：让小悟电脑上的本地 Agent 按本手册逐步执行，最终恢复小悟原有 Tunnel，使 ChatGPT 能通过现有 P05_Remote_Agent Connector 重新连接并接管小悟电脑。

当前阶段：V2。不要部署或启用 V3-A。

## 1. Git / 分支 / 文件位置

Git 仓库：
https://github.com/YanfengSong/P05_Remote_Agent.git

使用分支：
feat/v2-operator-console

最低要求 commit：
aee77db90a43752dee5c2103a49cd64bec920b96

不要使用：
wip/v3a-paused

本详细手册：
docs\handoff\XIAOWU_TAKEOVER_MANUAL.md

简版 handoff：
docs\handoff\XIAOWU_TAKEOVER_HANDOFF.md

小悟建议本地目录：
D:\Project_Git\P05_Remote_Agent

如果小悟已经有 P05 checkout 且路径不同，保留原路径，不要强行搬迁。

构建后的 MCP 入口：
<P05_REPO>\dist\index.js

目标 MCP 命令：
node --env-file-if-exists=<P05_REPO>\.env <P05_REPO>\dist\index.js

机器本地配置：
<P05_REPO>\.env
<P05_REPO>\.p05\device.json

这两个文件绝对不要从 Boonray 复制。

## 2. 强制规则

1. 不复制 Boonray 的 .env、device.json、tunnel id、alias、profile、API key。
2. 不把任何 key/token/Bearer 输出到聊天或 Git。
3. 不执行 git reset --hard。
4. 不删除未知本地修改。
5. Git 工作区脏时先 stash。
6. 优先复用小悟原有 tunnel，不新建 tunnel。
7. 本轮不创建或修改 Windows Scheduled Task。
8. 本轮不运行 wip/v3a-paused。
9. 本轮不直接运行 Boonray 参数化的 deployment 脚本。
10. 初始只授权 P05 自身 Repo，不授权 C:\ 或 D:\ 整盘。

## 3. 确认当前机器

PowerShell：

    hostname
    whoami
    [Environment]::OSVersion.VersionString

记录 hostname、Windows 用户、系统版本。若不是小悟机器，停止。

## 4. 找到或克隆 P05 Repo

先检查：

    Test-Path 'D:\Project_Git\P05_Remote_Agent'

若存在：

    $Repo = 'D:\Project_Git\P05_Remote_Agent'

若不存在，搜索：

    Get-ChildItem D:\Project_Git,C:\Project_Git,C:\Projects,D:\Projects -Directory -Filter P05_Remote_Agent -Recurse -ErrorAction SilentlyContinue | Select-Object -First 20 FullName

若仍没有：

    $Repo = 'D:\Project_Git\P05_Remote_Agent'
    New-Item -ItemType Directory -Path (Split-Path $Repo -Parent) -Force
    git clone https://github.com/YanfengSong/P05_Remote_Agent.git $Repo

然后：

    cd $Repo

## 5. 同步正确分支

先检查：

    git status --short --branch
    git remote -v

若工作区有改动：

    git stash push -u -m "XiaoiWu pre-handoff backup"

同步：

    git fetch origin
    git switch feat/v2-operator-console
    git pull --ff-only
    git rev-parse HEAD

HEAD 必须为 aee77db... 或它的后续 commit。

验证最低 baseline：

    git merge-base --is-ancestor aee77db90a43752dee5c2103a49cd64bec920b96 HEAD
    if ($LASTEXITCODE -ne 0) { throw 'P05 branch is older than required baseline.' }

## 6. 确认 Node.js

    Get-Command node.exe -ErrorAction SilentlyContinue
    Get-Command npm.cmd -ErrorAction SilentlyContinue
    node --version
    npm --version

没有 Node/npm 就停止并报告：
BLOCKED: Node.js is not installed/configured

## 7. 找到 tunnel-client

    Get-Command tunnel-client.exe -ErrorAction SilentlyContinue

若找不到：

    Get-ChildItem D:\Tools,C:\Tools,$env:LOCALAPPDATA,$env:APPDATA -Filter tunnel-client.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 20 FullName

找到后：

    $Tunnel = '<tunnel-client.exe 绝对路径>'
    & $Tunnel --version

## 8. 找到小悟原有 Tunnel

    & $Tunnel profiles list
    & $Tunnel runtimes list --json

转换为对象：

    $RuntimeList = (& $Tunnel runtimes list --json) | ConvertFrom-Json
    $RuntimeList.aliases | Select-Object alias,profile_name,profile_path,tunnel_id,description,name,health_url_file

人工确认属于小悟的记录，并记录：
- tunnel_alias
- tunnel_profile
- tunnel_profile_path
- tunnel_id
- health_url_file

如果找不到明确属于小悟的原 tunnel，停止：
BLOCKED: existing XiaoiWu tunnel identity not found

不要新建 tunnel。

## 9. 保留小悟本地身份

    cd $Repo
    Test-Path .env
    Test-Path .p05\device.json

存在就保留，不覆盖。

若 device.json 存在，可以查看 deviceId：

    Get-Content .p05\device.json

## 10. 配置小悟自己的 .env

若 .env 不存在：

    Copy-Item .env.example .env

若 Repo 是 D:\Project_Git\P05_Remote_Agent，推荐配置：

    REMOTE_AGENT_ALLOWED_ROOTS=D:\Project_Git\P05_Remote_Agent
    REMOTE_AGENT_DEFAULT_CWD=D:\Project_Git\P05_Remote_Agent
    P05_WORKSPACES_JSON=[{"id":"p05","root":"D:\\Project_Git\\P05_Remote_Agent","kind":"platform-source"}]
    P05_ACTIVE_WORKSPACE_ID=p05
    REMOTE_AGENT_SHELL_TIMEOUT_MS=120000
    P05_TOOL_PROFILE=developer
    MATLAB_MCP_ENABLED=false
    P05_OPERATOR_PORT=56301
    P05_OPERATOR_TUNNEL_ALIAS=p05-xiaoiwu

若 Repo 路径不同，替换为真实路径。
不要加入其它业务 Workspace。

## 11. 确认 Runtime API Key 存在，但绝不打印

检查当前进程：

    if ($env:CONTROL_PLANE_API_KEY) { 'present in process env' } else { 'not in process env' }

检查 HKCU：

    $k = Get-ItemProperty -Path 'HKCU:\Environment' -Name 'CONTROL_PLANE_API_KEY' -ErrorAction SilentlyContinue
    if ($k -and $k.CONTROL_PLANE_API_KEY) { 'present in HKCU environment' } else { 'not in HKCU environment' }

若只在 HKCU：

    if (-not $env:CONTROL_PLANE_API_KEY -and $k) { $env:CONTROL_PLANE_API_KEY = [string]$k.CONTROL_PLANE_API_KEY }

若两处都没有：
BLOCKED: XiaoiWu CONTROL_PLANE_API_KEY is missing

停止，不要把 key 发到聊天。

## 12. 安装依赖并编译

    cd $Repo
    npm ci
    npm run check
    npm run build
    Test-Path .\dist\index.js

要求全部成功，最后必须 True。

## 13. 检查旧 runtime/profile

定义：

    $Alias = '<小悟 alias>'
    $Profile = '<小悟 profile>'
    $TunnelId = '<小悟 tunnel id>'

执行：

    & $Tunnel runtimes status $Alias --json
    & $Tunnel doctor --profile $Profile --explain

若旧 profile 仍指向 127.0.0.1:8765/mcp，不新建 tunnel，只保留原 tunnel id 并更新本地 MCP 绑定。

## 14. 把小悟原 tunnel 绑定到当前 stdio MCP

    $Node = (Get-Command node.exe).Source
    $McpCommand = "$Node --env-file-if-exists=$Repo\.env $Repo\dist\index.js"

然后：

    & $Tunnel runtimes connect --alias $Alias --tunnel-id $TunnelId --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-command $McpCommand --profile $Profile

必须使用小悟原 alias/profile/tunnel id。

## 15. 验证 runtime

    & $Tunnel runtimes status $Alias --json
    $Info = (& $Tunnel runtimes list --json) | ConvertFrom-Json
    $Entry = $Info.aliases | Where-Object { $_.alias -eq $Alias } | Select-Object -First 1
    $Entry | Select-Object alias,profile_name,tunnel_id,health_url_file,config_path

## 16. 验证 health/ready

    $Base = (Get-Content $Entry.health_url_file -Raw).Trim()
    Invoke-WebRequest "$Base/healthz" -UseBasicParsing
    Invoke-WebRequest "$Base/readyz" -UseBasicParsing

必须 health=200、ready=200。

## 17. 验证 P05 profile/tool surface

在 runtime/tunnel 日志中找 p05.tool_profile。
目标 profile=developer。
应看到 fs_read、fs_write、git_status、command_run、shell_run 等 developer 工具。

如果 tunnel 已在线但 ChatGPT 仍只看到 device_info/ping，不要重建 tunnel。报告：
connector online, tool surface appears stale

## 18. 到这里停止

不要创建 P05-Runtime/P05-RestartBroker。
不要配置 Operator Console 开机自启。
不要启用 MATLAB。
不要启用 V3。
不要加其它 Workspace。

本轮目标只有：让现有 XiaoiWu ChatGPT Connector 重新在线。

## 19. 完成汇报模板

    XIAOWU_HANDOFF_READY

    hostname: <hostname>
    user: <windows user>
    repo: <absolute repo path>
    branch: feat/v2-operator-console
    commit: <git rev-parse HEAD>
    node_path: <path>
    node_version: <version>
    npm_version: <version>
    tunnel_client_path: <path>
    tunnel_client_version: <version>
    tunnel_alias: <xiaoiwu alias>
    tunnel_profile: <xiaoiwu profile>
    tunnel_profile_path: <path>
    tunnel_id: <xiaoiwu tunnel id>
    health: 200
    ready: 200
    p05_profile: developer
    device_identity: preserved | newly-created
    connector_tool_surface: developer | stale-discovery-only
    blockers: none

不要包含 API key、token、Bearer、.env 内容或 credentials。

最后告诉 operator：
请回到 ChatGPT 对话说：小悟 handoff ready，请接管。

## 20. ChatGPT 接管成功标准

ChatGPT 会先调用 device_info 和 ping。
成功标准：
1. 不再出现 Tunnel-client has not been seen。
2. hostname 是小悟，不是 Boonray。
3. XiaoiWu device id 稳定。
4. status online。
5. tool surface 能刷新到当前 P05。

最终 DoD：现有 XiaoiWu ChatGPT Connector 能从云端重新访问。

## 21. 立即停止并报告 blocker 的情况

- 找不到原 XiaoiWu tunnel id。
- 找不到原 alias/profile。
- CONTROL_PLANE_API_KEY 缺失。
- Git 拉不到 feat/v2-operator-console。
- npm ci/check/build 失败。
- tunnel doctor 有未解决 auth/control-plane 错误。
- health/ready 长时间不是 200。
- 需要复制 Boonray identity/secret。
- 需要 reset/delete 未知本地工作。
- Windows 要求新的 host-level 权限。
- 只能通过创建新 tunnel 才能继续。
