# P05 Remote Agent

P05 是一个面向 Windows 工程工作站的本地优先 Remote Agent。它让 ChatGPT 通过受控 MCP Tunnel 操作本机 Workspace、文件、Git、Shell、MATLAB/Simulink 等工程能力，同时保留明确的 Workspace 边界、审计、恢复与插件架构。

当前版本：**0.3.1**

当前部署模型：**Repo-local / Dual Runtime / Manual Control**

---

## 1. 当前架构

P05 当前固定为两个独立 Runtime Slot：

```text
ChatGPT Chat A
    ↓
@Boonray-A
    ↓
Tunnel A
    ↓
P05 Runtime A
    ↓
Workspace A


ChatGPT Chat B
    ↓
@Boonray-B
    ↓
Tunnel B
    ↓
P05 Runtime B
    ↓
Workspace B
```

A/B 使用**同一份 P05 代码**，只是启动两个独立进程实例。

它们分别拥有自己的：

- Tunnel ID / Tunnel Profile
- Device ID
- State
- Audit / Recovery
- Workspace binding
- Plugin / downstream runtime state

不存在两份 P05 Runtime 源码。

```text
同一份 dist/index.js
        │
        ├── launch-runtime.mjs A
        │      └── Runtime A
        │
        └── launch-runtime.mjs B
               └── Runtime B
```

---

## 2. 一仓库部署目标

P05 的正常运行链路已经收口到单一 Git 仓库：

```text
P05_Remote_Agent/
├─ bootstrap.ps1
├─ P05-Operator.cmd
├─ package.json
├─ package-lock.json
├─ src/
├─ dist/
├─ scripts/
└─ .p05/                     # machine-local, Git ignored
   ├─ tools/
   │  ├─ node/
   │  └─ tunnel-client/
   ├─ tunnel/
   │  ├─ profiles/
   │  ├─ health/
   │  └─ logs/
   ├─ runtime-a/
   │  └─ state/
   └─ runtime-b/
      └─ state/
```

正常运行不再依赖：

- `D:\Tools`
- `D:\Project_Git\_p05_deploy`
- 用户目录中的旧 tunnel-client profile
- Windows Scheduled Task

这些位置在旧机器上可能仍然存在，但已经不是当前 Repo-local 运行路径的一部分。

---

## 3. 新电脑部署

### 3.1 前置条件

新电脑只需要：

- Windows x64
- Git
- PowerShell
- 可访问 Node.js、GitHub/OpenAI 与 `api.openai.com` 的网络
- 两个已创建的 Tunnel ID
  - `@Boonray-A` 对应 Tunnel A
  - `@Boonray-B` 对应 Tunnel B
- 一个 OpenAI Control Plane API Key

A/B 可以共用同一个 API Key。

### 3.2 Clone

```powershell
git clone <P05_Remote_Agent repository>
cd P05_Remote_Agent
```

### 3.3 一键 Bootstrap

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Bootstrap 会交互式要求：

```text
Tunnel ID for @Boonray-A
Tunnel ID for @Boonray-B
OpenAI Control Plane API Key
```

API Key 使用安全输入，不建议作为命令行参数直接传入。

Bootstrap 会：

1. 下载固定版本 Node.js。
2. 下载固定版本 tunnel-client。
3. 根据发布方 checksum manifest 做 SHA-256 校验。
4. 将运行工具安装到 `.p05/tools`。
5. 创建本机私有 `.env`。
6. 写入 A/B Tunnel 配置。
7. 执行 `npm ci`。
8. 执行 `npm run build`。
9. 生成 A/B repo-local tunnel profiles。
10. 创建 A/B 独立 state 目录。

Bootstrap **不会**：

- 自动启动 Operator Console；
- 自动启动 Runtime A；
- 自动启动 Runtime B；
- 安装开机自启；
- 安装 Scheduled Task。

如果需要扩大 P05 可以访问的宿主目录，可显式提供：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -AllowedRoots "D:\Project_Git"
```

默认 authorization root 仅为当前 P05 仓库。

> 当前状态：Repo-local 部署代码、当前主机迁移、A/B Runtime、GUI 控制和回归测试均已验证。完整的“另一台全新 Windows 主机从零下载并部署”仍建议在删除旧环境前做一次最终验收。

---

## 4. 日常使用

P05 默认采用**完全手动模式**。

电脑启动以后：

```text
Operator Console  OFF
Runtime A         OFF
Runtime B         OFF
```

需要使用时，双击仓库根目录：

```text
P05-Operator.cmd
```

它会启动本地 Operator Console 并打开：

```text
http://127.0.0.1:56301/
```

Operator Console 使用 repo-local Node：

```text
<repo>\.p05\tools\node\node.exe
```

不依赖系统 Node。

---

## 5. Operator Console

Operator Console 是 P05 的本地控制面。

它只绑定：

```text
127.0.0.1
```

当前主要控制关系：

```text
P05 Operator Console
│
├── Console
│   ├── 当前状态
│   ├── 刷新
│   └── 关闭 Console
│
├── Runtime A · @Boonray-A
│   ├── 启动 / 关闭
│   ├── 重启
│   └── Workspace 绑定
│
└── Runtime B · @Boonray-B
    ├── 启动 / 关闭
    ├── 重启
    └── Workspace 绑定
```

Console、Runtime A、Runtime B 的生命周期互相独立。

已经验证：

- 关闭 Runtime B，不影响 Runtime A。
- 再启动 Runtime B，`@Boonray-B` 可以恢复在线。
- 重启 Runtime B，不影响 Runtime A。
- 关闭 Operator Console，不会自动关闭 A/B。
- Operator Console 可以随后通过 `P05-Operator.cmd` 再次手动启动。

Runtime 状态区分：

- `OFFLINE`：Tunnel/Runtime 未启动。
- `READY`：Tunnel 已就绪，等待 ChatGPT 首次请求唤醒 stdio MCP。
- `ONLINE`：P05 MCP 与本地 Control Bridge 已在线。

---

## 6. Workspace 模型

Workspace 不是文件浏览器目录，而是 P05 的逻辑工程执行范围。

每个 Runtime Slot 独立绑定自己的 Workspace：

```text
Runtime A → Workspace A
Runtime B → Workspace B
```

绑定持久保存在：

```text
.p05/runtime-a/state/active-workspace.txt
.p05/runtime-b/state/active-workspace.txt
```

所以 Runtime 重启后仍会回到自己的 Workspace。

GUI 选择一个新目录时，P05 会：

1. 将目录设置为当前临时 Workspace；
2. 注册为正式 Workspace；
3. 保存到该 Slot 的持久配置；
4. 后续重启继续使用该 Workspace。

结构化文件/Git 工具受 active Workspace 约束。

跨 Workspace 的结构化访问默认拒绝：

```text
structuredCrossWorkspace = deny
```

Shell 使用的是 trusted-user 模型：起始 cwd 受 Workspace 约束，但 PowerShell 本身仍具有当前 Windows 用户权限。它不是 OS sandbox。

详细模型见：

- [Permission Model](docs/architecture/PERMISSION-MODEL.md)
- [Target Architecture V2](docs/architecture/TARGET_ARCHITECTURE_V2.md)

---

## 7. Tool Profiles

P05 Tool Profile 采用累计权限模型并 fail closed。

| Profile | 主要能力 |
|---|---|
| `discovery` | `device_info`, `ping` |
| `readonly` | Workspace / Audit / Recovery / Plugin 查询、文件读取、Git status/diff |
| `developer` | Workspace 切换、文件修改、Git 本地修改、Shell、Runtime restart、下游 MCP discovery |
| `full` | developer + `git_push` + generic `mcp_call_tool` |

当前开发机通常使用：

```text
P05_TOOL_PROFILE=developer
```

`git_push` 和 generic `mcp_call_tool` 仍保持在更高权限层。

---

## 8. Repo-local Runtime 控制

A/B Runtime 共用以下脚本：

```text
scripts/deployment/launch-runtime.mjs
scripts/deployment/run-runtime-slot.ps1
scripts/deployment/stop-runtime-slot.ps1
scripts/deployment/restart-runtime-slot.ps1
scripts/deployment/request-restart-runtime-slot.ps1
```

示例：

```powershell
.\scripts\deployment\run-runtime-slot.ps1 -Slot A
.\scripts\deployment\stop-runtime-slot.ps1 -Slot A

.\scripts\deployment\run-runtime-slot.ps1 -Slot B
.\scripts\deployment\restart-runtime-slot.ps1 -Slot B
```

聊天中的 MCP 工具：

```text
runtime_restart
```

也已经使用 repo-local restart 链路，不再依赖外部 RestartBroker / Scheduled Task。

Runtime 自重启采用延迟 detached restart，使当前 MCP 请求能够先正常返回，再停止并重新启动对应 Slot。

---

## 9. State / Secrets

整个 `.p05/` 目录被 Git ignore。

其中包含：

- repo-local Node
- repo-local tunnel-client
- A/B tunnel profiles
- health metadata
- tunnel logs
- A/B Device ID
- Audit / Recovery
- Workspace binding

`.env` 同样被 Git ignore。

Fresh install 时，`bootstrap.ps1` 会将 API Key 写入本机私有 `.env`。

Tunnel profile 内保存的是：

```text
env:CONTROL_PLANE_API_KEY
```

而不是 Key 明文。

请勿提交：

```text
.env
.p05/
```

---

## 10. MATLAB / Simulink Plugin

MATLAB/Simulink 属于 P05 Application Plugin，不进入 Core。

当前集成方式：

```text
P05 Core
    ↓
MATLAB Plugin
    ↓
MathWorks Agentic Toolkit / MATLAB MCP Server
    ↓
MATLAB + Simulink
```

插件支持：

- MathWorks Agentic Toolkit 自动发现；
- MATLAB base tools；
- Simulink extension tools；
- MATLAB / Simulink Skill Catalog；
- active Workspace binding；
- Workspace 路径参数保护；
- reused MATLAB Session pwd 同步。

MathWorks 的 `SKILL.md` 当前作为 MATLAB Plugin 提供的只读 Skill Catalog / guidance asset，不等同于 P05 V3 的可执行 Skill Runtime。

详细说明见：

- [Plugin Framework](docs/architecture/PLUGIN-FRAMEWORK.md)

---

## 11. Runtime / Audit / Recovery

所有暴露工具走统一生命周期：

```text
prepare
  ↓
authorize
  ↓
execute
  ↓
verify
  ↓
complete

failed → recovery hint
```

Audit 记录持久化元数据，例如：

- execution id
- capability
- Workspace id
- phase/state
- duration
- classified error
- recovery hint

不会持久化：

- raw file contents
- raw downstream arguments
- secret-like command parameters

查询工具：

- `activity_recent`
- `recovery_status`

A/B Runtime 使用独立 Audit/Recovery state，因此一个 Runtime 的事件不会混入另一个 Runtime。

---

## 12. 当前验证状态

本轮 Repo-local / Dual Runtime 收口已经实测：

```text
npm run check
PASS

npm run build
PASS

POLICY_PROFILES_OK
239 checks

PROFILE_EXPOSURE_OK
162 checks

TEMP_READONLY_OK
49 checks

OPERATOR_CONSOLE_OK
37 checks

PLUGIN_FRAMEWORK_OK
30 checks

FOUNDATION_OK
35 checks

DOWNSTREAM_SMOKE_OK
PASS
```

同时已实机验证：

- `@Boonray-A` 与 `@Boonray-B` 是独立 P05 Runtime。
- 两边 Device ID 不同。
- Audit state 隔离。
- A/B Workspace 独立。
- A/B 手动启停独立。
- Runtime B repo-local restart 后只保留一个 tunnel-client + 一个 Node child。
- A/B Runtime 和 Operator Console 当前进程均从 `<repo>/.p05` 启动。
- 当前运行进程对 `D:\Tools` 的依赖计数为 0。
- 当前运行进程对旧用户 tunnel-client profile/state 的依赖计数为 0。

---

## 13. Legacy 环境

旧机器可能仍存在：

```text
D:\Tools\...
D:\Project_Git\_p05_deploy
%APPDATA%\tunnel-client\...
%USERPROFILE%\.local\state\tunnel-client\...
P05-Runtime Scheduled Task
P05-Operator Scheduled Task
P05-RestartBroker*
```

当前 Repo-local 正常运行链路已经不需要它们。

**不要因为 README 更新就自动删除这些旧路径。**

建议顺序：

1. 在当前机器完成 Repo-local A/B 验证。
2. 在另一台干净 Windows 主机完成 Fresh Clone + `bootstrap.ps1` 最终验收。
3. 确认无回退需要。
4. 再单独执行 Legacy Cleanup。

---

## 14. 开发验证

常用：

```powershell
npm run check
npm run build
```

完整 npm 验证入口：

```powershell
npm run verify
```

Operator Console 回归：

```powershell
node dist/test/operator-console.js
```

Policy 回归：

```powershell
node dist/test/policy-profiles.js
```

---

## 15. 架构文档

当前基线：

- [Project Status](PROJECT_STATUS.md)
- [Target Architecture V2](docs/architecture/TARGET_ARCHITECTURE_V2.md)
- [Permission Model](docs/architecture/PERMISSION-MODEL.md)
- [Tool Profiles](docs/architecture/TOOL-PROFILES.md)
- [Plugin Framework](docs/architecture/PLUGIN-FRAMEWORK.md)

长期目标：

- [Target Architecture V3](docs/architecture/TARGET_ARCHITECTURE_V3.md)
- [Agent / Skill / Asset Contracts](docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md)
- [Agent / Skill / Orchestrator ADR](docs/adr/ADR-0012-agent-skill-orchestrator.md)

部署细节：

- [Repo-local Deployment](scripts/deployment/README.md)

---

## 16. 当前边界

当前已经稳定的是：

```text
ChatGPT Connector
      1 : 1
P05 Runtime Slot
      1 : 1
Active Workspace
```

即：

```text
@Boonray-A ↔ Runtime A ↔ Workspace A
@Boonray-B ↔ Runtime B ↔ Workspace B
```

这解决的是两个并行 ChatGPT 对话 / 两个工程上下文的本机执行隔离。

后续如果需要超过两个并行 Runtime，再考虑将固定 A/B Slot 抽象成动态 Runtime Registry；当前阶段不提前增加这层复杂度。
