# P05 Remote Agent 执行方案

> 目标：逐步构建一套可替代 Remote Desktop Commander 的本地 Remote Agent。  
> 核心原则：分阶段实现、默认最小权限、GitHub 为唯一真源、优先减少 ChatGPT ↔ 本机工具调用次数。

## 1. 当前基线

本地仓库：`F:\Project_Git\P05_Remote_Agent`  
远端仓库：`YanfengSong/P05_Remote_Agent`

当前设备：

```text
hostname: XiaoiWu
deviceId: p05-1362e78d-db4d-4296-acb1-62c330dfae98
```

已完成：

- `device_info`、`ping`
- `.p05/device.json` 持久化稳定 Device ID
- `npm run build` 通过
- `npm run smoke:downstream` 通过
- 本机 Streamable HTTP MCP 已跑通：`http://127.0.0.1:8765/mcp`
- `/healthz` 返回 200 / ok
- Inspector CLI 已通过 HTTP 调用 `device_info`
- `tunnel-client v0.0.14` 已安装并可运行

## 2. 最终目标架构

```text
ChatGPT
   │ MCP
   ▼
OpenAI Secure MCP Tunnel
   ▼
tunnel-client
   ▼
P05 Remote Agent
   ├─ Device
   ├─ Files
   ├─ Git
   ├─ Process
   ├─ Command
   ├─ Batch / Task
   └─ Downstream MCP
          └─ MATLAB MCP
```

后续如需摆脱 OpenAI Tunnel，可替换为自建 `P05 Self-hosted Relay`，但 Agent 本体尽量不重写。

## 3. 强制规则

### GitHub 是唯一真源

正式资产必须进入仓库：

```text
src/
docs/
scripts/
tests/
README.md
PROJECT_STATUS.md
.env.example
```

禁止提交：

```text
.env
API Key / OAuth Token / Admin Key / Runtime Key
node_modules/
dist/
.p05/
tunnel-client 二进制
```

### 默认最小权限

首次远程接入只允许：

```text
device_info
ping
```

禁止一开始暴露：

```text
shell_run
fs_write
mcp_call_tool
raw shell
文件删除
git reset --hard
```

### Secret

Secret 只能来自环境变量或本机安全存储，不能进入源码、README、脚本、日志和 Git。

## 4. TASK-001：Tool Profile Safety

这是当前第一优先级。

实现环境变量：

```text
P05_TOOL_PROFILE
```

支持：

```text
discovery
readonly
developer
full
```

权限建议：

```text
discovery:
  device_info
  ping

readonly:
  discovery +
  fs_read
  fs_list
  fs_search
  git_status
  git_diff
  git_log

developer:
  readonly +
  fs_write
  apply_patch
  process_start
  process_wait
  受控 Git 修改
  downstream MCP

full:
  developer +
  高风险操作
```

默认：

```text
P05_TOOL_PROFILE=discovery
```

建议新增：

```text
src/policy/tool-profile.ts
```

统一通过：

```text
isToolAllowed(toolName)
```

### TASK-001 DoD

`P05_TOOL_PROFILE=discovery` 时，`tools/list` 只能看到：

```text
device_info
ping
```

以下工具必须不可见：

```text
shell_run
fs_write
mcp_call_tool
```

验证：

```powershell
npm run build
npm run smoke:downstream
```

全部通过后更新 README、PROJECT_STATUS，并单独 commit，然后停止。

## 5. TASK-002：Secure Tunnel Integration

前提：本机 MCP 已运行：

```text
http://127.0.0.1:8765/mcp
```

Tunnel Client：`v0.0.14`

建议 `.gitignore`：

```text
tunnel-client-*/
tools/tunnel-client/*.exe
```

严格区分：

```text
Tunnel ID        → 标识 Tunnel
Runtime API Key  → doctor / run
Admin API Key    → Tunnel CRUD，仅管理时使用
```

长期 daemon 禁止使用 Admin Key。

Runtime Key 仅通过：

```powershell
$env:CONTROL_PLANE_API_KEY="..."
```

初始化：

```powershell
.\tunnel-client.exe init `
  --sample sample_mcp_remote_no_auth `
  --profile p05-xiaoiwu `
  --tunnel-id <TUNNEL_ID> `
  --mcp-server-url http://127.0.0.1:8765/mcp
```

检查：

```powershell
.\tunnel-client.exe doctor `
  --profile p05-xiaoiwu `
  --explain
```

只有 doctor 通过后才运行：

```powershell
.\tunnel-client.exe run --profile p05-xiaoiwu
```

DoD：ChatGPT 能通过 Tunnel 调用 `device_info` 和 `ping`，返回 XiaoiWu 的稳定 Device ID。

## 6. TASK-003：Readonly File Tools

只实现：

```text
fs_read
fs_list
fs_search
```

不要先开放写。

本机 `.env`：

```text
REMOTE_AGENT_ALLOWED_ROOTS=F:\Project_Git
REMOTE_AGENT_DEFAULT_CWD=F:\Project_Git
```

必须防止 `symlink / junction / reparse point` 逃逸 Allowed Root。

## 7. TASK-004：Git 专用工具

不要所有 Git 都走 PowerShell。

使用：

```text
execFile("git", args)
```

第一批只读：

```text
git_status
git_diff
git_diff_stat
git_log
git_branch
```

第二批再增加：

```text
git_checkout
git_add
git_commit
git_restore
```

默认禁止：

```text
git reset --hard
git clean -fd
force push
```

## 8. TASK-005：Process Manager

这是替代 Remote Desktop Commander 的核心能力。

建议：

```text
src/process/
  manager.ts
  session.ts
```

工具：

```text
process_start
process_wait
process_output
process_stop
process_status
```

重点是 `process_wait`：让 P05 在本地等待进程状态变化，避免 ChatGPT 高频调用 `read_process_output`。

## 9. TASK-006：Batch Execute

新增：

```text
batch_execute
```

支持一次请求执行多步：

```json
{
  "steps": [
    {"op": "fs_read", "path": "..."},
    {"op": "git_status", "repo": "..."},
    {"op": "process_run", "command": "npm test", "cwd": "..."}
  ],
  "stopOnError": true
}
```

限制：

```text
max steps = 20
max runtime
max output bytes
```

目标：ChatGPT 1 次调用，P05 本地完成多步操作。

## 10. TASK-007：run_task

在 Batch 稳定后实现高层任务，例如：

```json
{
  "task": "validate_repo",
  "workspace": "F:\\Project_Git\\xxx"
}
```

内部完成：

```text
git status
build
test
git diff
结果压缩
```

ChatGPT 只接收一次最终结果。

## 11. TASK-008：MATLAB MCP

不要重新实现 MATLAB 控制。

继续使用：

```text
P05
 ↓ Downstream MCP Client
MathWorks MATLAB MCP
 ↓
MATLAB
```

建议封装高层工具：

```text
matlab_status
matlab_eval
matlab_run_file
simulink_update
simulink_build
simulink_run
matlab_test
```

最终目标：

```text
simulink_verify()
```

一次调用内部完成 update/build/simulate/test/diagnostics。

## 12. Command 安全重构

当前 `shell_run` 后续应逐步淘汰。

优先实现：

```text
command_run
```

采用 executable allowlist：

```text
git
node
npm
npx
python
dotnet
cmake
approved scripts
approved MATLAB commands
```

默认禁止任意：

```text
powershell -Command
cmd /c
```

如保留 `raw_shell`，必须要求 `profile=full + 显式审批`。

## 13. Audit 与 Output 限制

日志目录：

```text
.p05/logs/
```

JSONL 记录：

```json
{
  "time": "...",
  "deviceId": "...",
  "tool": "fs_read",
  "cwd": "...",
  "status": "success",
  "durationMs": 42
}
```

不得记录 Secret 或完整敏感正文。

所有工具必须限制 stdout/stderr/file/tool result，建议默认最大 1 MB，并标记 `truncated=true`。

## 14. Approval

以下能力默认 Block：

```text
fs_delete
git_reset_hard
process_kill_tree
raw_shell
registry changes
service changes
```

未来再增加审批机制，禁止 AI 自己批准自己。

## 15. Windows 自启动

系统稳定后再做。

优先使用 Windows Task Scheduler：

```text
P05 Remote Agent
P05 Tunnel Client
```

第一阶段不要做 Windows Service。

## 16. 建议目录结构

```text
P05_Remote_Agent/
├─ src/
│  ├─ device/
│  ├─ policy/
│  ├─ tools/
│  ├─ process/
│  ├─ downstream/
│  ├─ audit/
│  └─ index.ts
├─ scripts/
│  ├─ start-local.ps1
│  ├─ verify.ps1
│  └─ tunnel/
│     ├─ doctor.ps1
│     └─ start-tunnel.ps1
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  ├─ deployment/
│  ├─ security/
│  └─ research/
├─ .env.example
├─ .gitignore
├─ PROJECT_STATUS.md
├─ README.md
└─ package.json
```

## 17. Verify Pipeline

增加：

```powershell
npm run verify
```

至少执行：

```text
npm run check
npm run build
npm run smoke:downstream
npm run test
```

额外自动验证：

```text
device_id stable
allowed root escape denied
dangerous command denied
discovery profile tool list correct
readonly profile tool list correct
process cleanup correct
```

## 18. Milestones

```text
V0.3-A Device Discovery        ✅
V0.3-B Local HTTP              ✅
V0.3-C Secure Tunnel           ⬜
V0.4   Readonly Remote Agent   ⬜
V0.5   Developer Agent         ⬜
V0.6   Efficient Agent         ⬜
V0.7   MATLAB                  ⬜
```

## 19. 当前立即执行任务

本地 AI Agent 当前只执行：

```text
TASK-001：Tool Profile Safety
```

步骤：

```text
1. git status
2. git pull --ff-only
3. 创建 feat/remote-agent-v03
4. 实现 P05_TOOL_PROFILE
5. 默认 discovery
6. discovery 仅暴露 device_info + ping
7. 写 Tool Profile 测试
8. npm run build
9. npm run smoke:downstream
10. 更新 README
11. 更新 PROJECT_STATUS.md
12. commit
13. 停止
```

完成后输出：

```text
TASK-001 RESULT

Status:
PASS / FAIL

Changed:
- ...

Validation:
- ...

Risks:
- ...

Commit:
- ...

Next recommended task:
TASK-002 Tunnel Integration
```

## 20. 强制停止条件

遇到以下情况必须停止并报告：

```text
需要 API Key
需要 Admin Key
需要删除用户文件
需要管理员权限
需要修改系统防火墙
需要修改 Windows Registry
需要安装系统级服务
需要公开公网端口
Git 工作区存在未知用户修改
测试失败原因不明确
```

禁止 AI Agent 主动从浏览器缓存、Credential Manager、历史日志等位置搜集 Secret。

## 21. 核心目标

始终围绕：

```text
少量 ChatGPT 工具调用
→ P05 本地完成大量操作
→ 返回压缩结果
```

这才是 P05 相比 Remote Desktop Commander 最重要的价值。
