# P05 Remote Agent

P05 是一个面向 Windows 工程工作站的本地优先 Remote Agent / MCP 平台。

它的目标不是单纯“远程执行命令”，而是让 ChatGPT、Gemini 以及其他 MCP Client 在**明确的 Runtime、Workspace、权限和审计边界**下访问本机工程能力，包括文件、Git、MATLAB/Simulink、参考资料和外部审查流程。

当前版本：**0.3.1**

当前主要形态：

```text
Repo-local
Dual Runtime A/B
Local Operator Control
Plugin Runtime
Workspace + Reference Roots
OpenAI Tunnel
Native Streamable HTTP MCP Reviewer
```

> 当前分支仍包含一批尚未提交的 V2.x 能力增强。本文描述的是**当前工作树已实现并验证的能力**，不等同于已发布 Release。

## 近期新增能力记录

本轮在原有 Dual Runtime / Plugin / MATLAB 基础上，主要新增和修正了：

1. **Runtime Workspace 权限边界收紧**
   - Local Operator 成为 Workspace Binding 的唯一授权入口；
   - Remote MCP 的 `workspace_switch` 已彻底移除；
   - ChatGPT / 外部 Agent 只能查看当前 Workspace，不能自行切换或扩权。

2. **Runtime-scoped Reference Roots**
   - 每个 Runtime 支持多个只读参考目录；
   - 支持 `reference_list` / `reference_read` / `reference_list_directory`；
   - Reference Root 只允许读取，不授予 Write / Git / Shell / MATLAB 权限；
   - A/B 独立持久化。

3. **Plugin GUI Start / Stop**
   - Operator 可按 Runtime 单独启动/停止 Plugin；
   - Plugin Stop 会关闭其已连接 downstream；
   - Downstream 增加 `READY / CONNECTED / UNAVAILABLE / DISABLED` 语义；
   - MATLAB 保持 lazy-connect。

4. **Native Streamable HTTP MCP Reviewer**
   - 新增 `127.0.0.1:8765/mcp` 标准 HTTP MCP 入口；
   - 固定绑定 Runtime B + `readonly`；
   - 自动跟随 B 的当前 Workspace；
   - 外部客户端不能调用写入、Shell、Workspace rebind 或 MATLAB。

5. **OAuth Reviewer**
   - 增加 OAuth Protected Resource Metadata；
   - Authorization Server Metadata；
   - Authorization Code + PKCE；
   - Access / Refresh Token；
   - Reviewer scope 固定为 `p05.review`。

6. **外部 HTTPS / Gemini 验证**
   - 使用 repo-local Cloudflare Quick Tunnel 完成临时公网 HTTPS；
   - Gemini Connected App 已成功发现 P05 Reviewer；
   - Gemini 已真实执行 P02 工程 Git / 文档审查；
   - 已完成 Gemini Finding → 主 Agent 二次复核的外部审查闭环。

7. **标准 MCP ToolAnnotations**
   - P05 根据 Capability Catalog 自动生成 ToolAnnotations；
   - Reviewer 全部只读工具均声明为 read-only / non-destructive / idempotent / closed-world；
   - 为 Gemini、Claude、Cursor 等 MCP Client 提供标准风险提示。

---


## 1. 当前能做什么

### 1.1 ChatGPT 远程访问本机工程

P05 当前可通过 OpenAI Tunnel 将本地 MCP Runtime 暴露给 ChatGPT：

```text
ChatGPT
   ↓
OpenAI Tunnel / Control Plane
   ↓
tunnel-client
   ↓
P05 Runtime A / B
   ↓
Workspace / Plugin / Downstream
```

当前已实机验证：

- `@Boonray-A` 可连接 Runtime A；
- `@Boonray-B` 可连接 Runtime B；
- 两个 Runtime 可独立启动、停止、重启；
- 两个 Runtime 可绑定不同 Workspace；
- 两边拥有独立 state / audit / workspace / plugin runtime；
- 一个 Runtime 重启不会中断另一个 Runtime。

---

### 1.2 本机文件与 Git 工程操作

在授权的 Active Workspace 内，P05 可提供：

#### 只读

- `fs_read`
- `fs_list`
- `git_status`
- `git_diff`
- `git_diff_stat`

#### Developer

- `fs_write`
- `apply_patch`
- `git_add`
- `git_commit`
- `git_branch`
- `shell_run`
- `runtime_restart`

#### Full

- `git_push`
- generic downstream `mcp_call_tool`

结构化文件和 Git 工具都受 Active Workspace 权限边界约束。

---

### 1.3 Workspace：可操作工程边界

每个 Runtime 同时只有 **1 个 Active Workspace**：

```text
Runtime A → Workspace A
Runtime B → Workspace B
```

Workspace 是当前 Runtime 的**人类授权操作边界**，不是普通目录导航状态。

当前规则：

- 本地 Operator 可以选择目录并“设为工作区”；
- A/B Workspace 独立；
- Workspace 绑定会持久化；
- Runtime 重启后恢复自己的 Workspace；
- ChatGPT / Remote MCP **不能自行切换 Workspace**；
- 远程 `workspace_switch` 已从 Capability Catalog 和 MCP surface 中移除；
- Remote Agent 只能查看 `workspace_list` / `workspace_current`，然后在当前 Workspace 内工作。

核心原则：

> **Workspace Binding is Human-controlled Runtime authority, not Agent-controlled navigation.**

即：

```text
用户 / Local Operator
      ↓
授权 Workspace
      ↓
Runtime
      ↓
Agent 只能在这个边界内工作
```

---

### 1.4 Reference Roots：多个只读参考目录

除了 1 个 Active Workspace，每个 Runtime 还可以授权**多个 Reference Root**：

```text
Runtime B

Workspace
D:\Project_Git\P02_Vmodel
    ├─ Read   ✅
    ├─ Write  ✅
    ├─ Git    ✅
    ├─ Shell  ✅
    └─ MATLAB ✅

Reference Roots
D:\Project_Git\P05_Remote_Agent
D:\Documents\Specs
D:\Project_Git\OtherProject
    ├─ Read   ✅
    ├─ List   ✅
    ├─ Write  ❌
    ├─ Git    ❌
    ├─ Shell  ❌
    └─ MATLAB ❌
```

Reference Root 只能由本地 Operator 添加/移除。

Remote MCP 只能使用：

- `reference_list`
- `reference_read`
- `reference_list_directory`

远程客户端不能自行授权新的 Reference Root。

Reference Root：

- 支持多个；
- A/B 独立；
- Runtime-scoped；
- 重启后持久化；
- 移除只撤销读取授权，不删除磁盘目录；
- 不扩大 Workspace 写权限。

---

### 1.5 Local Operator Console

根目录：

```text
P05-Operator.cmd
```

启动本地 Operator：

```text
http://127.0.0.1:56301/
```

Operator 只绑定 loopback。

当前 Operator 能力：

```text
P05 Operator
│
├─ Runtime A
│  ├─ Start / Stop / Restart
│  ├─ Workspace 选择 / 绑定
│  ├─ Reference Roots 添加 / 移除
│  ├─ Plugin Start / Stop
│  └─ Downstream 状态
│
└─ Runtime B
   ├─ Start / Stop / Restart
   ├─ Workspace 选择 / 绑定
   ├─ Reference Roots 添加 / 移除
   ├─ Plugin Start / Stop
   └─ Downstream 状态
```

Operator 是本地 Human Control Plane。

Operator 的“实时行为 / 持久 Audit”会聚合 Runtime A 与 Runtime B 的主 MCP 事件，按时间排序，并显示来源标签，例如：

```text
[A] MCP
[B] MCP
```

这样可以直接区分同一台机器上 A/B Runtime 发起的主 MCP 行为。历史事件即使没有新 attribution 字段，也会根据其所属 Runtime bridge 补出 A/B Slot。

Audit attribution 数据模型同时支持 `http-reviewer` / `operator` / `internal` 等来源；当前 HTTP Reviewer 仍使用独立 Reviewer Audit，尚未合并进主界面的 Live Activity，Operator 本地控制动作也尚未统一写入主 Runtime Audit。

它与 Remote MCP 的权限语义不同：

- Local Operator 可以改变 Runtime Workspace 授权；
- Local Operator 可以增加/移除 Reference Root；
- Remote Agent 不能执行这些授权动作。

---

## 2. Dual Runtime 架构

P05 当前固定为两个 Runtime Slot：

```text
ChatGPT Chat A
    ↓
@Boonray-A
    ↓
Tunnel A
    ↓
Runtime A
    ↓
Workspace A


ChatGPT Chat B
    ↓
@Boonray-B
    ↓
Tunnel B
    ↓
Runtime B
    ↓
Workspace B
```

A/B 使用同一份代码：

```text
dist/index.js
    │
    ├─ launch-runtime.mjs A
    │      └─ Runtime A
    │
    └─ launch-runtime.mjs B
           └─ Runtime B
```

每个 Slot 分别拥有：

- Device ID；
- Tunnel profile；
- Runtime state；
- Audit / Recovery；
- Workspace binding；
- Reference Roots；
- Plugin runtime state；
- Downstream state。

---

## 3. Plugin Framework

P05 Core 不直接承载具体业务应用。

当前方向：

```text
P05 Core
├─ Capability / Policy
├─ Workspace / Reference
├─ Audit / Recovery
├─ Transport
└─ Plugin Runtime
     ├─ MATLAB / Simulink
     ├─ future Reviewer providers
     └─ future domain plugins
```

当前 Plugin Framework 已支持：

- Stable Plugin ID / version / API version；
- Plugin Catalog；
- enabled / ready / running / failed / stopped 生命周期；
- Plugin failure isolation；
- Workspace-aware plugin availability；
- Plugin-owned downstream；
- Runtime A/B 独立 Plugin state；
- Operator GUI 单插件 Start / Stop；
- Stop 时关闭该 Plugin 已连接的 downstream；
- Start 后保留 downstream lazy-connect。

Operator 中插件状态语义：

- `DISABLED`
- `READY`
- `CONNECTED`
- `UNAVAILABLE`
- Plugin lifecycle 的 `running / stopped / failed`

其中 downstream：

> `READY` 表示已配置可用，但尚未建立活跃连接；首次调用时自动连接。

---

## 4. MATLAB / Simulink Plugin

MATLAB/Simulink 当前作为 Application Plugin 接入，不进入 Core。

```text
P05 Core
   ↓
MATLAB Plugin
   ↓
MathWorks MCP / Agentic Toolkit
   ↓
MATLAB + Simulink
```

当前已实现并验证：

- MATLAB Plugin v2.x；
- MathWorks MCP downstream；
- MATLAB tool discovery；
- MATLAB Skill Catalog；
- active Workspace binding；
- Workspace 路径保护；
- MATLAB session pwd 同步；
- lazy connect；
- Operator Plugin Start / Stop；
- Runtime A/B 独立状态。

真实验证示例：

```text
Runtime B
Workspace = p02_vmodel

MATLAB evaluate:
disp(2+2)
disp(pwd)

Result:
4
D:\Project_Git\P02_Vmodel
```

---

## 5. Native HTTP MCP Reviewer

P05 现在除了 OpenAI Tunnel / stdio Runtime 之外，还实现了一个**原生 Streamable HTTP MCP Reviewer**。

默认本地地址：

```text
http://127.0.0.1:8765/mcp
```

健康检查：

```text
http://127.0.0.1:8765/healthz
```

启动：

```powershell
npm run start:http-reviewer
```

测试：

```powershell
npm run test:http-reviewer
```

默认语义：

```text
HTTP Reviewer
   ↓
Runtime B state
   ↓
Profile = readonly
   ↓
Current Runtime B Workspace
```

Reviewer 每次请求重新读取 Runtime B 的 active Workspace state。

因此：

- Operator 改 B Workspace；
- Reviewer 不需要重启；
- 下一次 MCP 请求会自动跟随新的 B Workspace；
- Reviewer 自己不能切 Workspace。

---

## 6. 外部 Reviewer / Gemini 接入

HTTP Reviewer 设计为外部只读审查入口，可以供标准 MCP Client 使用。

当前已真实验证 Gemini 自定义 MCP Connected App。

链路：

```text
Gemini
   ↓
HTTPS
   ↓
OAuth
   ↓
P05 HTTP Reviewer
   ↓
Runtime B
   ↓
p02_vmodel
```

当前 Reviewer 暴露的工具：

```text
device_info
ping

workspace_list
workspace_current
review_context

fs_read
fs_list

git_status
git_diff
git_diff_stat

reference_list
reference_read
reference_list_directory
```

明确不暴露：

```text
fs_write
apply_patch
shell_run
command_run
workspace_switch
git_commit
git_push
matlab.call_tool
generic mcp_call_tool
```

Fresh Context 规则：

- 外部 Reviewer 在回答“当前 Workspace / Git / 文件 / Diff / 审查状态”之前，应先调用 `review_context`；
- `review_context` 每次返回当前 Runtime B Workspace、Git 状态、Reference Roots、时间戳和 Reviewer 权限边界；
- 不允许把对话历史中的旧 Workspace / branch 状态当作当前事实；
- `workspace_list` / `workspace_current` 仅用于查询，不能切换或重新绑定 Workspace；
- Reviewer 明确声明 `canControlRuntime=false`、`canSwitchWorkspace=false`、`canWrite=false`、`canExecuteShell=false`。

适合用途：

- Git working tree review；
- git diff review；
- 文档一致性审查；
- V-Model SRS / TDD / MDD / V&V 交叉审查；
- Reference Root 辅助资料读取；
- 外部第二模型独立 Review；
- 设备在线 / Runtime 状态检查。

当前已经完成一次真实 Gemini Reviewer 验证：

```text
Gemini
  ↓
读取 P02_Vmodel
  ↓
git_status / git_diff
  ↓
跨文档审查
  ↓
输出 Review Findings
  ↓
ChatGPT 独立复核 Findings
```

即：

> 外部 Reviewer 负责发现问题和给出证据，主 Agent 负责复核后再决定是否执行修改。

---

## 7. HTTP Reviewer OAuth

HTTP Reviewer 当前实现了用于外部 MCP Client 的 OAuth preview。

支持：

- OAuth Protected Resource Metadata；
- Authorization Server Metadata；
- Authorization Code；
- PKCE S256；
- Access Token；
- Refresh Token；
- `client_secret_basic`；
- `client_secret_post`；
- Access / Refresh token 状态以 SHA-256 hash + expiry 持久化到 Runtime state，Reviewer 进程重启后仍保持有效。

当前 scope 固定：

```text
p05.review
```

客户端不能通过 OAuth 请求：

- developer；
- full；
- Workspace rebind；
- Reference authorization；
- Shell；
- MATLAB；
- 写文件。

OAuth Client ID / Secret 保存在 Runtime-specific `.p05` state 中，不进入 Git。

---

## 8. Public HTTPS 测试入口

为了验证 Gemini 等云端 MCP Client，当前开发环境支持使用 Cloudflare Quick Tunnel 将：

```text
127.0.0.1:8765
```

临时映射为：

```text
https://<ephemeral>.trycloudflare.com/mcp
```

当前使用的是**测试级 Quick Tunnel**。

特点：

- HTTPS；
- 可供 Gemini Web 等云端客户端访问；
- 不需要把本机端口直接裸露到公网；
- URL 是临时的；
- cloudflared 重启后地址可能变化；
- 不作为生产部署方式。

`cloudflared.exe` 保存在：

```text
.p05/tools/cloudflared/
```

不安装到系统 PATH。

后续若需要长期稳定使用，应升级为：

- Named Tunnel；
- 固定域名；
- Operator-managed Start / Stop；
- 更完整 Principal / Credential lifecycle。

---

## 9. MCP ToolAnnotations

P05 现在会根据 Capability Catalog 自动为工具生成标准 MCP `ToolAnnotations`。

对于 Reviewer 中的只读工具：

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

这些 annotations 由 Capability 的：

- `risk`
- `scope`

统一生成，而不是每个工具手工维护。

用途：

- Gemini；
- Claude；
- Cursor；
- 其他 MCP Client；

都可以从协议层知道该工具是否只读、破坏性、幂等、是否面向开放世界。

> ToolAnnotations 是客户端决策 hint，不是安全边界。真正的权限仍由 P05 Profile / Workspace / Capability Policy 强制执行。

---

## 10. Tool Profiles

P05 使用累计权限 Profile，并 fail closed。

| Profile | 能力 |
|---|---|
| `discovery` | `device_info`, `ping` |
| `readonly` | Workspace awareness、Reference、Audit、Recovery、Plugin 查询、文件读取、Git status/diff |
| `developer` | readonly + 文件修改、Git 本地修改、Shell、Runtime restart、downstream discovery |
| `full` | developer + `git_push` + generic downstream tool call |

重要：

> Remote `workspace_switch` 已移除，不属于 developer/full。

Workspace 授权只能由 Local Operator 控制。

---

## 11. 权限模型

当前 P05 的核心边界：

### Workspace

```text
Human-authorized
Read / Write / Git / Shell / Plugin
```

### Reference Root

```text
Human-authorized
Read / List only
```

### Remote Agent

```text
Cannot expand Workspace authority
Cannot authorize Reference Root
Cannot switch Runtime Workspace
```

### Shell

`shell_run` 仍采用 trusted-user 模型：

- 起始 cwd 受 Workspace 边界约束；
- PowerShell 实际拥有当前 Windows 用户权限；
- 不是 OS Sandbox。

因此：

> Structured tools 已有严格 Workspace boundary；Shell 的完全 OS 级隔离仍属于更高层安全能力。

---

## 12. Audit / Recovery

工具调用统一经过：

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

Audit 保存：

- execution id；
- capability；
- Workspace id；
- source（如 `runtime-mcp` / `http-reviewer`）；
- transport（如 `stdio` / `streamable-http`）；
- Runtime Slot（A / B）；
- principal（存在明确认证身份时）；
- MCP client name / version（协议实际提供时，仅用于显示和审计，不参与授权）；
- phase / state；
- duration；
- classified error；
- recovery hint。

不会持久化：

- raw file content；
- secret value；
- raw downstream secret arguments。

查询：

- `activity_recent`
- `recovery_status`

A/B Audit state 独立。

HTTP Reviewer 使用自己的 reviewer audit 文件，避免和主 Runtime audit 相互覆盖。

---

## 13. Repo-local Layout

正常运行依赖都收敛在仓库中：

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
   │  ├─ tunnel-client/
   │  └─ cloudflared/
   ├─ tunnel/
   ├─ runtime-a/
   │  └─ state/
   └─ runtime-b/
      └─ state/
```

`.p05/` 中可能包含：

- repo-local Node；
- tunnel-client；
- cloudflared；
- Runtime state；
- Device ID；
- Audit / Recovery；
- Workspace binding；
- Reference Roots；
- HTTP Reviewer token；
- OAuth Client ID / Secret；
- Quick Tunnel URL / logs。

整个 `.p05/` 被 Git ignore。

`.env` 同样不得提交。

---

## 14. 部署

### 基础要求

当前主要目标平台：

- Windows x64；
- Git；
- PowerShell；
- 可访问 GitHub / OpenAI 等所需网络。

### Clone

```powershell
git clone <P05_Remote_Agent repository>
cd P05_Remote_Agent
```

### Bootstrap

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Bootstrap 负责：

- repo-local Node；
- tunnel-client；
- checksum 校验；
- `.p05/tools`；
- `.env`；
- npm dependencies；
- build；
- Runtime state；
- Tunnel profile。

当前部署优化方向：

- Runtime A/B 应可独立选择；
- 不应强制必须同时部署两个通道；
- 环境依赖应自动检测；
- 缺失依赖应由脚本自动处理；
- 网络/代理应有 preflight 和自诊断；
- Core Ready 与 Plugin/Downstream Ready 分开。

部署 DoD 只要求 Core：

```text
Source
→ Preflight
→ Core dependencies
→ Network
→ Build
→ Runtime
→ /readyz
→ ping / device_info
→ P05 DEPLOYMENT READY
```

MATLAB / Plugin / Reviewer 不应成为 Core deployment gate。

---

## 15. 日常使用

### 启动 Operator

```text
P05-Operator.cmd
```

### Runtime Script

```powershell
.\scripts\deployment\run-runtime-slot.ps1 -Slot A
.\scripts\deployment\stop-runtime-slot.ps1 -Slot A
.\scripts\deployment\restart-runtime-slot.ps1 -Slot A

.\scripts\deployment\run-runtime-slot.ps1 -Slot B
.\scripts\deployment\stop-runtime-slot.ps1 -Slot B
.\scripts\deployment\restart-runtime-slot.ps1 -Slot B
```

### HTTP Reviewer

```powershell
npm run start:http-reviewer
```

### Developer checks

```powershell
npm run check
npm run build
npm run verify
```

---

## 16. 当前回归验证

最近一轮关键验证：

```text
npm run check
PASS

npm run build
PASS

POLICY_PROFILES_OK
251 checks

PROFILE_EXPOSURE_OK
161 checks

HTTP_REVIEWER_OK
55 checks

FOUNDATION_OK
40 checks

GIT_MUTATIONS_OK
13 checks

OPERATOR_CONSOLE_OK
60 checks

OUTPUT_SCHEMA_OK
177 checks

PLUGIN_FRAMEWORK_OK
35 checks

PLUGIN_API_V1_OK
4 checks
```

另外已验证：

- A/B Runtime 独立；
- A/B Workspace 独立；
- Workspace restart persistence；
- Reference Roots 多目录只读；
- Plugin Start / Stop；
- MATLAB lazy connect；
- MATLAB Workspace binding；
- HTTP Streamable MCP；
- HTTP Reviewer readonly surface；
- OAuth Authorization Code + PKCE；
- Refresh Token；
- Public HTTPS Quick Tunnel；
- Gemini Connected App；
- MCP ToolAnnotations，并对全部 Core tools 的 `tools/list` annotations 做协议层回归；
- Gemini 对真实 P02 工程执行 Git / 文档审查。

---

## 17. 当前明确边界

### 已经实现

```text
2 个固定 Runtime Slot
1 Runtime : 1 Active Workspace
1 Runtime : N Reference Roots
Runtime-scoped Plugin state
OpenAI stdio Tunnel
Native HTTP Reviewer
External readonly MCP Client
OAuth Reviewer identity
Gemini external review
```

### 尚未作为 V2.x 完整能力实现

- 动态 N Runtime Registry；
- 多 Principal 完整身份系统；
- 多 Session 并发隔离；
- Session-scoped authority delegation；
- Resource Broker / Lease；
- 多 Agent 同时争用 MATLAB 等 stateful external resource 的统一仲裁；
- OS-level Shell sandbox；
- production-grade OAuth lifecycle；
- production fixed-domain HTTP MCP service；
- arbitrary public plugin marketplace。

这些属于 V3 或后续安全/平台化阶段。

---

## 18. V3 方向

V3 不会推翻当前能力，而是在当前 V2.x 基础上抽象：

```text
Principal
  ↓
Agent Session
  ↓
Execution Context
  ↓
Capability / Authority
  ↓
Component / Fiber
  ↓
Resource Broker / Lease
  ↓
External Resources
```

重点：

- Principal Identity；
- Session Manager；
- Component / Fiber；
- Resource Ownership；
- Cross-runtime Lease；
- Crash recovery；
- Capability delegation；
- 多 Agent 并发隔离；
- Durable Audit correlation。

---

## 19. 架构文档

主要入口：

- [Project Status](PROJECT_STATUS.md)
- [Permission Model](docs/architecture/PERMISSION-MODEL.md)
- [Tool Profiles](docs/architecture/TOOL-PROFILES.md)
- [Plugin Framework](docs/architecture/PLUGIN-FRAMEWORK.md)
- [Target Architecture V1](docs/architecture/TARGET_ARCHITECTURE_V1.md)
- [Target Architecture V2](docs/architecture/TARGET_ARCHITECTURE_V2.md)
- [Target Architecture V3](docs/architecture/TARGET_ARCHITECTURE_V3.md)
- [Target Architecture V3A](docs/architecture/TARGET_ARCHITECTURE_V3A.md)
- [Context Component Runtime](docs/architecture/CONTEXT-COMPONENT-RUNTIME.md)
- [Agent / Skill / Asset Contracts](docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md)
- [Repo-local Deployment](scripts/deployment/README.md)

---

## 20. 项目定位

P05 当前已经不只是“ChatGPT 远程控制电脑”的工具。

更准确的定位是：

> **一个以本地工程工作站为执行节点、以 MCP 为标准接口、以 Workspace/Capability/Policy 为权限边界、支持多 Runtime、Plugin、MATLAB 和外部 Reviewer 的本地优先 Agent Platform。**

当前验证过的客户端包括：

```text
ChatGPT
Gemini
标准 MCP SDK Client
```

未来任何支持标准 MCP 的客户端，都可以在不破坏 P05 Core 权限模型的前提下接入。
