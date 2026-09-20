# P05 Host Deployment

本目录保存 P05 的可版本化主机部署脚本。主机授权状态仍由 Windows Task Scheduler 持有；脚本本身进入 Git。

## Files

- `common.ps1`：从 `.env` 和 tunnel-client alias metadata 解析机器本地 Node、tunnel-client、alias、profile、tunnel id、health/log 路径。
- `run-runtime.ps1`：启动/恢复当前 alias 对应的 Tunnel + P05 stdio MCP。
- `run-runtime.cmd`：兼容包装器，实际调用 `run-runtime.ps1`。
- `restart-runtime.ps1`：只停止当前 P05 alias 和 `dist/index.js` MCP，不杀 Operator Console 或其它 Node。
- `run-operator.ps1`：确保本地 Operator Console 在 loopback 上运行，不自动弹浏览器。
- `install-host-tasks.ps1`：安装/更新 `P05-Runtime`、`P05-RestartBroker`、`P05-Operator`。
- `uninstall-host-tasks.ps1`：移除上述三个任务。

## Machine-local .env

至少需要：

```dotenv
P05_TOOL_PROFILE=developer
P05_OPERATOR_TUNNEL_ALIAS=<this-machine-alias>
P05_OPERATOR_RUNTIME_TASK=P05-Runtime
P05_OPERATOR_RESTART_TASK=P05-RestartBroker
P05_OPERATOR_TASK=P05-Operator
```

当 Node/tunnel-client 不在 PATH 时，增加：

```dotenv
P05_NODE_PATH=<absolute node.exe>
P05_OPERATOR_TUNNEL_CLIENT=<absolute tunnel-client.exe>
```

`CONTROL_PLANE_API_KEY` 不写入 `.env`；deployment 从当前进程或 `HKCU\Environment` 读取。

## Install

在已建立 tunnel alias、P05 已 build、`.env` 已配置后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\install-host-tasks.ps1 -StartNow
```

任务语义：

- `P05-Runtime`：当前用户登录后延迟 8 秒启动；
- `P05-Operator`：当前用户登录后延迟 12 秒启动；
- `P05-RestartBroker`：无自动 trigger，仅由固定 `runtime_restart` / Operator Console 重启按钮调用。

所有 Task Action 必须指向当前 Repo 内 `scripts\deployment\`，不依赖 Repo 外业务脚本。

## Verify

检查任务：

```powershell
Get-ScheduledTask -TaskName P05-Runtime,P05-RestartBroker,P05-Operator
```

检查 Operator：

```powershell
Invoke-WebRequest http://127.0.0.1:56301/healthz -UseBasicParsing
```

检查 Tunnel：

```powershell
<tunnel-client> runtimes status <alias> --json
```

最终应满足：Operator Console 持续在线；Runtime restart 时 MCP PID 变化但 Operator PID 不变；Tunnel `ready=true`；ChatGPT Connector 可重新 `ping`。

## Security boundary

- Repo 内脚本可以版本管理和自开发；
- `.env`、`.p05`、Runtime API key 不进 Git；
- 新增/修改 Windows Scheduled Task 属于主机级持久变更，需要 operator 明确授权；
- Workspace 授权扩展仍必须单独批准。


## Machine-local overrides

The default restart task name is `P05-RestartBroker`. A host with a legacy task ACL or a different broker name may set:

```dotenv
P05_OPERATOR_RESTART_TASK=P05-RestartBroker-V2
```

The MCP caller still cannot choose a task name at runtime; only machine-local configuration can select the provisioned broker.

If a host requires a control-plane proxy, keep it in that host's local `.env` rather than in source-controlled scripts:

```dotenv
CONTROL_PLANE_HTTP_PROXY=http://127.0.0.1:7892
HTTPS_PROXY=http://127.0.0.1:7892
HTTP_PROXY=http://127.0.0.1:7892
```

Machines that do not need a proxy should omit these variables.
