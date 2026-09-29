# V3 本机开发交接

记录日期：2026-09-29。本文描述已落地的配置和已取得的验证证据，不把规划功能当成已交付功能。

## 1. 工作树和版本基线

| 项目 | 当前值 |
|---|---|
| 开发分支 | `v3` |
| V3 工作树 | `C:\Users\EDY\.codex\worktrees\v3-development\P05_Remote_Agent` |
| 原工作目录 | `D:\Project_Git\P05_Remote_Agent` |
| 原目录分支 | `feature/shell-approval-gate`；原有未提交改动保留在原目录 |
| V3 原始提交 | `56bbf7134af91229b00111a66849442e3c5143a0` |
| 合入的 V2 提交 | `3ebd9a6281f0a030add1c29e0bfcc2ddd8964ff9` |
| 合并提交 | `c259ecc`，以本地 Git 的完整 SHA 为准 |
| 实现改动 | 当前保存在 V3 工作树，尚未作为完整 V3 发布、推送或部署 |
| 技术方案 | `docs/architecture/P05_V3_TECHNICAL_SOLUTION.md` |
| 外部参考证据 | `docs/research/P05_V3_GITHUB_REFERENCE_SNAPSHOT.json` |

开发时务必先确认工作目录。不要在原目录检出 V3 或覆盖原有 V2 未提交内容。仓库 shell 操作遵守 `C:\Users\EDY\.codex\RTK.md`，命令以 `rtk` 开头。

## 2. 已确认的环境

- 本机 Windows，PowerShell；Node.js `v24.19.0`。
- SQLite 使用 Node 内置 `node:sqlite`，本机探针版本 `3.53.3`；尚未完成全部目标平台资格验证。
- TypeScript：ES2023 / NodeNext / strict；依赖以 `package-lock.json` 为准。
- MCP SDK：`@modelcontextprotocol/client`、`@modelcontextprotocol/server` 2.x；Zod 4.x。
- PTY 新依赖固定为 `node-pty@1.1.0`，已从本地 npm 缓存离线安装并更新锁文件。当前 Node 24/Windows ConPTY 的真实 TTY、输入、缩放探针通过；独立 Terminal Host 仍在开发，不能用探针代替产品验收。
- `npm ci --offline` 已在 V3 工作树成功执行。这里不需要沿用原目录的 `.env`。
- 所有新验收使用隔离临时目录和测试进程；没有接管已部署 A/B，没有重启用户 MATLAB 或远程主机。

用户明确指定先做本机验证，Linux/SSH、MATLAB、硬件实机环境稍后提供。

## 3. Core 配置

Core 入口：`src/v3-main.ts`，构建后 `dist/v3-main.js`。

机器可读定义：[v3-config.schema.json](../schemas/v3-config.schema.json)。它从实际 Zod 校验器生成；修改配置代码后执行 `npm run build` 和 `node dist/v3-config-schema.js --write-docs` 更新，避免人工字段表与代码漂移。运行时还会检查真实路径/ACL，这些条件不能仅靠 JSON Schema 验证。不要给严格配置文件加入未声明的 `$schema` 字段，可通过编辑器的外部 schema association 关联。

启动前通过 `P05_V3_CONFIG` 指定本地配置文件。配置采用严格校验，未知字段拒绝。下面的路径是示例，**不是本机已部署目录**：

```json
{
  "version": 1,
  "slotId": "A",
  "stateDir": "C:\\P05-V3-State",
  "workspaceId": "demo",
  "workspaceRoot": "D:\\P05-V3-Workspace",
  "authorizationRevision": "local-policy-1",
  "principal": "local-operator",
  "port": 0,
  "optionalRuntime": true,
  "trustedHost": false,
  "allowWrites": false
}
```

| 字段 | 必需/默认 | 约束及含义 |
|---|---|---|
| `version` | 必需 | 当前为 `1` |
| `slotId` | 必需 | `A` 或 `B`；每 Slot 独立 Core 所有权和持久数据库 |
| `stateDir` | 必需 | 绝对本地路径；受保护状态目录，与 Workspace 双向不重叠 |
| `workspaceId` | 必需 | 1–64 个字母、数字、点、下划线、连字符 |
| `workspaceRoot` | 必需 | 已存在目录的绝对路径；启动时解析真实路径 |
| `authorizationRevision` | 必需 | 1–128 字符；变更会使旧执行的授权重验证失败 |
| `principal` | 必需 | 1–128 字符；由本地配置绑定，MCP 调用不能自行指定 |
| `port` | 默认 `0` | 0–65535；`0` 分配临时端口，只监听 `127.0.0.1` |
| `optionalRuntime` | 默认 `true` | 启动独立 V2 只读兼容进程，提供 Git 状态/差异能力 |
| `trustedHost` | 默认 `false` | 显式接受当前兼容后端的信任边界；不会跳过 ACL 验证 |
| `allowWrites` | 默认 `false` | 开启文件写能力还要求 `trustedHost=true`；每次写入仍进入审批 |
| `workflowCatalog` | 可选 | 受保护本地 JSON 目录文件的绝对路径；不配置则 Workflow RPC 返回依赖不可用 |
| `workflowAutoAdvance` | 默认 `true` | 配置有效目录后启动后台推进；`false` 为显式 tick 模式 |
| `processHostConnection` | 可选 | 受保护的外部 Process Host 连接 JSON 绝对路径，见 §6 |
| `allowHostExecute` | 默认 `false` | 独立于 `allowWrites`；要求 `trustedHost=true` 及 Process Host 配置，每次进程执行仍需 E4 审批 |

### 状态保护前提

配置文件必须位于 Workspace 外；配置文件及其父目录、状态目录均需通过真实所有者/权限检查。Windows 仅接受当前身份、SYSTEM、Administrators 的 Allow 规则，包含对子项生效的继承规则检查；POSIX 要求当前所有者且其他身份无访问位。扫描拒绝链接/重解析点，当前上限 4096 项。

这属于状态保护检查，**不是 OS 执行沙箱**。本实现不会自动修改已有用户目录的 ACL。测试辅助函数仅为新建临时目录设置测试权限；不能作为生产安装器使用。

当前兼容文件读取层继承 V2 的进程级配置边界，因此每个进程只能启动一个绑定 Workspace 的 Application。不同 Slot 应使用不同进程。

## 4. 启动、连接与凭据

在 V3 工作树中构建：

```powershell
rtk proxy npm ci --offline
rtk proxy npm run build
```

在当前终端会话设置环境变量，再启动 Core：

首次安装可先使用新的配置初始化器（父目录和 Workspace 必须已存在，状态目录必须尚不存在）：

```powershell
rtk proxy npm run setup:v3 -- 'C:\P05-V3-State' 'D:\P05-V3-Workspace' A local-operator
```

初始化器只为刚创建的空目录配置私有权限并写入只读默认配置，拒绝覆盖已有目录，不启动服务、不启用写入或 HostExecute。初始化失败时保留现场供检查，不自动删除用户路径。`v3-setup` 已通过实际 ACL、现有配置不变、Workspace 重叠拒绝测试。这是最小本机配置初始化，尚不是完整生产安装/升级器。

```powershell
$env:P05_V3_CONFIG = 'C:\P05-V3-State\config.json'
rtk proxy npm run start:v3
```

以上环境赋值是操作说明，不会更改系统永久环境变量。首次启动会为当前 Slot 创建不同的客户端和 Operator 凭据。不要把凭据内容复制到交接文档、代码库、日志或 Workspace。

```text
stateDir/
  host.sqlite                   Host 身份
  slots/
    a/                          Slot A；B 对应 b/
      owner-lock.sqlite         生命周期独占锁，禁止删除或用 TTL/PID 替代
      core.sqlite               Core 状态、所有权、版本化 CAS 状态
      runs.sqlite               执行、审批、事件、尝试与回执
      client.token              Edge 凭据
      operator.token            本地 Operator 凭据
      connection.json           endpoint、slotId、clientTokenFile；不含 token 内容
  optional-v2/...                独立 V2 兼容运行时状态
```

SQLite 可能存在 `-wal`、`-shm`、`-journal` 辅助文件。不能只复制主数据库文件作为运行中备份，也不能删除锁文件来“恢复服务”。正式备份/恢复工具尚未完成。

Edge 入口 `dist/v3-edge.js` 使用：

| 环境变量 | 用途 |
|---|---|
| `P05_V3_ENDPOINT` | Core 发布的 loopback RPC URL |
| `P05_V3_CLIENT_TOKEN_FILE` | 当前 Slot 的客户端 token 文件；优先于直接 token |
| `P05_V3_CLIENT_TOKEN` | 备用直接 token 配置；交接和日常配置优先使用文件 |

```powershell
$env:P05_V3_ENDPOINT = '<connection.json 中的 endpoint>'
$env:P05_V3_CLIENT_TOKEN_FILE = 'C:\P05-V3-State\slots\a\client.token'
rtk proxy npm run start:v3-edge
```

Edge 提供 stdio MCP，不负责 Core 生命周期。客户端断开/关闭 Edge 不会停止 Core。

同一物理 Host 启动 B 时，在已有私有状态目录内另建 B 配置，设置 `slotId=B` 及对应 principal/Workspace；若 A/B 属于同一 Host，保留相同 `stateDir`，从而共享 Host 身份并使用不同 `slots/a`、`slots/b`。两份配置分别交给独立 Core 进程。不要重新生成或复制 A 的 token 作为 B 凭据。`setup:v3` 为避免覆盖而拒绝已存在目录，添加 B 不是再次对同一路径运行初始化器。

本地 Operator 入口：

```powershell
rtk proxy npm run operator:v3 -- 'C:\P05-V3-State\slots\a\connection.json' status
rtk proxy npm run operator:v3 -- 'C:\P05-V3-State\slots\a\connection.json' approvals
rtk proxy npm run operator:v3 -- 'C:\P05-V3-State\slots\a\connection.json' inspect '<executionId>'
rtk proxy npm run operator:v3 -- 'C:\P05-V3-State\slots\a\connection.json' approve '<approvalId>' '<decisionVersion>'
rtk proxy npm run operator:v3 -- 'C:\P05-V3-State\slots\a\connection.json' deny '<approvalId>' '<decisionVersion>'
```

审批应先检查不可变输入，再用准确的审批版本作决定。Operator token 不交给 Edge；客户端 token 调用 Operator 方法会被拒绝。

## 5. 当前接入的功能

### MCP 工具

`execution_submit/status/wait/events/cancel`、`execution_process_status/output`、`core_status`、`capability_list`，以及 `workflow_list/start/status/tick/cancel/resume/scheduler_status`。

`execution_submit` 输入为 `{capability,input,idempotencyKey}`。执行上下文由 Core 固定配置生成；不能通过工具参数改 principal、Slot 或 Workspace。等待超时只表示等待结束，不意味着取消或失败。

### 文件与 Git 能力

| 能力 | 输入 | 当前行为 |
|---|---|---|
| `fs_read` | `{path}` | 复用 V2 路径防护；响应文本上限 48 KiB |
| `fs_list` | `{path}` | 复用 V2 路径防护；响应上限 48 KiB，未实现分页 |
| `fs_write` | `{path,content,expectedSha256}` | 写入需本地开关、实际权限验证及审批；content 上限 48K 字符 |
| `git_status` | `{}` | 经独立 V2 Optional Host 的 readonly profile 调用 |
| `git_diff` | `{staged?:boolean}` | 同上 |
| `process_run` | `{executable,args}` | 需外部 Process Host、HostExecute 开关及审批；不是受限文件写能力 |

`expectedSha256=null` 表示仅创建，不覆盖现有文件；非空表示待写文件的预期 SHA-256。审批后会重新检查内容和路径，不接受把路径改成链接来转移写入目标。当前后端仍有同身份并发修改的 TOCTOU 边界，不声称提供 OS 沙箱或外部原子 CAS。

### Workflow

目录文件顶层为 `{version:1,skills:[],routes:[],workflows:[]}`。具体 IR 类型见 `src/v3/workflows/types.ts`；可运行三阶段示例由 `src/test/v3-workflow-catalog.ts` 生成。

Skill 固定 revision、scope、输入/输出 schema、能力版本、预算、有限 IR 和 DoD；Workflow 引用固定 Skill 与 Route revision。已持久化运行保存定义快照和摘要，重启不会换成新定义。写节点仍走同一执行审批内核。

`workflow_start` 建立持久运行并登记后台调度；默认自动推进，`workflow_status` 是只读查询。`workflowAutoAdvance=false` 时可用 `workflow_tick` 手动推进。后台默认间隔 250 ms、并发 4、活动容量 128、单 tick 观测期限 30 秒、连续错误 3 次暂停，审计保留 256 条；这些内部默认目前没有暴露成 config 字段。

`workflow_scheduler_status` 显示调度/暂停和发现失败数；`workflow_resume` 显式恢复观察，不能让 UNKNOWN 外部执行重新派发。Core 重启按有界分页发现已持久化 Workflow，补登记与创建之间的中断窗口；中断中的 tick 或 UNKNOWN 流程保持暂停。停止 Core 停止调度，不等于用户取消。目录损坏或缺依赖时只禁用 Workflow，Core 诊断/文件能力仍可用。

并行写操作拒绝，尚未实现隔离工作树的并行写后端。应用未安装商业 Agent Provider，不能把测试 callback 当成真实模型服务。

## 6. 独立 Process Host

实现入口：`src/v3-process-host.ts`；启动命令 `rtk proxy npm run start:v3-process`。通过 `P05_V3_PROCESS_CONFIG` 指定受保护 JSON 配置：

```json
{
  "stateDir": "C:\\P05-V3-State\\process-a",
  "workspaceRoot": "D:\\P05-V3-Workspace",
  "slot": "A",
  "principal": "local-operator",
  "securityMode": "trusted-host",
  "clientTokenFile": "C:\\P05-V3-State\\process-config\\core.token",
  "operatorTokenFile": "C:\\P05-V3-State\\process-config\\reserved-operator.token",
  "port": 0
}
```

两份凭据须事先在受保护目录配置，满足传输层长度约束且彼此不同，不应复用 Edge token。Host 写 `stateDir/endpoint.json` 发布 URL、PID、boot ID，不输出 token 内容。

IPC 为 `process_submit/status/output/cancel/health`。`owner={slot,principal,runId,attemptId}` 由可信 Core 桥接生成；不能直接暴露给不受信工具调用方。executable 必须绝对路径，args 数组传递，cwd 固定为 Workspace，不做 shell 字符串拼接。状态先登记再 spawn，dispatchKey 去重。

默认并发 8、任务记录 1000、单任务 stdout+stderr 总存储 20 MiB、全宿主输出 200 MiB；输出按 4 KiB 页存储，单次读取不超过 64 KiB。支持配置 `maxConcurrent/maxProcesses/maxOutputBytes/maxStoredOutputBytes`，以入口和 Host 校验为准。

已验证独立宿主在 Core 客户端退出后继续执行、输出/回执跨重启、重复派发唯一副作用、跨 owner 拒绝、独占锁竞争。宿主被强杀后未完成任务记 UNKNOWN，禁止自动重放；只对本宿主持有的进程句柄发取消，不根据任意 PID 杀进程。进程树终止明确为未确认。PTY/SSH 和 OS 文件/网络隔离未完成。

Core 桥接已接入，并完成实际 Application 的审批前零副作用、审批后唯一执行和输出分页测试。连接文件格式：

```json
{
  "version": 1,
  "url": "http://127.0.0.1:实际端口",
  "clientTokenFile": "C:\\P05-V3-State\\process-config\\core.token",
  "slot": "A",
  "principal": "local-operator",
  "workspaceRoot": "D:\\P05-V3-Workspace",
  "securityMode": "trusted-host"
}
```

配置文件及凭据须通过权限验证；桥接会核对远端健康响应的绑定摘要。宿主不可用时 Core 保留其他诊断/文件能力，不注册进程能力。Core 不停止外部宿主。`port=0` 的宿主重启后端口可能改变，需要维护者更新受保护连接文件并重启 Core 加载新绑定。

进程观测默认最多 10 分钟，超出后 Core 记 UNKNOWN，宿主工作可能继续，不能自动重发。可用 `execution_process_status` 查询原回执，`execution_process_output` 按 byte offset 继续读取原输出。用户取消 UNKNOWN Run 时，桥接只查找并取消原 dispatchKey 对应任务；不可达时返回取消未确认，禁止新派发。Core 正常关闭使用独立 detach 原因，只停止观测，不发送取消。进程树未确认终止时仍保留 UNKNOWN。当前 Workflow 权限模型尚未支持 HostExecute，因此不会把 `process_run` 注册进 Workflow 能力集合。

新增桥接专项 `v3-process-bridge` 已通过：原审批执行、幂等、等待断开后继续、输出摘要和分页、非零退出、观测截止 UNKNOWN、强杀宿主 UNKNOWN、UNKNOWN 后取消原进程、跨 principal 取消拒绝、Core detach 不取消、初始 detach 不派发、祖先 junction 凭据边界拒绝。

## 7. 其他模块的边界

- `src/v3/resources`：Host 资源租约、原子多资源申请、FIFO、fencing、重启隔离已实现并测试。独立跨 Slot RPC 服务已完成初步本机验证，应用执行适配仍未完成；不能每个 Slot 分别启动一个协调器并绕过共同锁。入口 `dist/v3-resource-host.js`，环境变量 `P05_V3_RESOURCE_CONFIG`，命令 `npm run start:v3-resource`；具体 Slot listener、凭据和 runContext 配置见该模块文档。
- `src/v3/composition`：scope、provider 依赖、生命周期清理、pin/drain、候选替换、观察事件、受限 interceptor、Shadow gateway 和资产版本已实现并测试。尚未整体接入生产 Optional Host 或安装器；不是任意 JS 的安全沙箱。
- `src/v3/core`：稳定身份、Slot 独占锁、故障降级、服务期望状态与版本化 CAS。崩溃后的旧所有权通过本地恢复 CLI 显式确认，不能手工改 DB 绕过。
- `src/v3/durable`：执行/审批/事件/回执事务化，幂等键、版本 CAS、恢复 UNKNOWN、存储故障闭锁。payload 当前为受保护目录内明文，尚未完成加密 PayloadStore。

## 8. 已取得的验证证据

模块配置索引：

- [Resource Host 配置与权限](../../src/v3/resources/RESOURCE_HOST_CONFIGURATION.md)：每 Slot listener、固定主体、凭据、RunContext、租约及无终止验证器时的恢复限制。
- [Composition 与 Asset 接口](../../src/v3/composition/README.md)：依赖、scope、pin/drain、外部效果和资产激活。
- [Skill / Workflow 合同](../../src/v3/workflows/README.md)：定义、预算、CAS 后端、Provider 和恢复语义。

上述链接从仓库 `docs/handoff` 解析到源码模块；代码实现与最新统一验证是最终依据。

### V2 兼容回归

在 V3 工作树内，仅为测试进程设置 `REMOTE_AGENT_ALLOWED_ROOTS` 和 `REMOTE_AGENT_DEFAULT_CWD` 为该工作树，运行 `npm run test:compiled`，退出码 `0`：

| 套件 | 结果 |
|---|---|
| Policy profiles | 281 checks |
| Profile exposure | 196 checks |
| HTTP Reviewer | 55 checks |
| Foundation | 49 checks |
| Git mutations | 13 checks |
| Operator console | 76 checks |
| Output schema | 176 checks |
| Plugin framework | 35 checks |
| Plugin API v1 | 4 checks |
| Downstream smoke | PASS |

修复了 Windows PowerShell 子进程继承 PowerShell 7 `PSModulePath` 的兼容问题，以及 audit 文件原子替换遇临时 Windows 文件锁时的有界重试；均有专门回归。

### V3 本机统一验证

```powershell
rtk proxy npm run verify:v3
```

最新已收取纳入初始化、进程桥接、资源宿主、调度和恢复的一轮完整结果，退出码 `0`：类型检查、构建及 17 组本机测试全部通过。后续 PTY/隔离实验属于新增工作，不自动继承此结论。

| 套件 | 核心证据 |
|---|---|
| windows-powershell-env | 实际 SHA-256；父进程环境保持不变 |
| atomic-replace | 临时锁重试、有界失败、保留目标文件 |
| v3-core | 54 checks |
| v3-durable | SQLite 恢复、幂等、审批 CAS、所有权、等待/取消、撤权与回执 |
| v3-transport | 真实 HTTP 和 stdio MCP、凭据角色、限额、Edge 关闭后 Core 存活 |
| v3-protection | 真实私有 ACL、继承权限泄露拒绝、重解析点拒绝 |
| v3-setup | 新状态目录私有权限、只读默认值、已有配置保持、重叠拒绝 |
| v3-optional | 实际 V2 只读工具、固定 Workspace、独立状态/生命周期、审批不被绕过 |
| v3-process | 独立宿主、客户端退出、持久去重/输出/回执、强杀后 UNKNOWN |
| v3-process-bridge | 真实审批、凭据真实路径、UNKNOWN 取消、Core detach/重连与输出分页 |
| v3-resources | 53 checks |
| v3-resource-host | 30 checks；跨 Slot 认证、争用、上下文、重启隔离 |
| v3-composition | 53 checks |
| v3-workflows | 三阶段恢复、固定版本、有限循环/并行、UNKNOWN/取消与安全重试 |
| v3-workflow-scheduler | 24 checks；恢复、并发/退避、UNKNOWN 暂停、停止后的迟到回调保护 |
| v3-recovery | 真实强杀、显式旧 owner、原 Run 保留、恢复原因和正常释放 |
| v3-application | 真实 ACL + SQLite + MCP + Git；三阶段审批跨重启；链接替换拒绝与撤权 |

这份成功结果对应已编译的该轮代码。后续正在编辑的桥接/资源服务等文件不自动继承这个通过结论，必须重新构建并补测试。

## 9. 交接后的优先事项

### 本地异常退出恢复

```powershell
rtk proxy npm run recovery:v3 -- 'C:\P05-V3-State\config.json' inspect
rtk proxy npm run recovery:v3 -- 'C:\P05-V3-State\config.json' resume '<owner.coreInstanceId>' '检查结论与恢复原因'
```

先 inspect 获取旧 owner ID；记录中的 `active` 只表示上次未正常释放，`liveness=unverified`，不能据此断言旧进程已死。检查外部宿主及未确认副作用后，再指定准确 owner ID 和原因 resume。恢复进程本身就是新常驻 Core，继续原状态/Slot/Run、递增 generation 并记录恢复原因。独占锁内再次确认 owner，活 Core 持锁、ID 不匹配、已正常释放的旧 owner 都不能用过期恢复指令接管。

此操作仅本机 CLI，不提供 MCP/RPC 恢复入口，不删除或改写数据库/锁文件，不重放 UNKNOWN，不证明外部进程树已停止。Windows 强制终止仍视作异常退出；Ctrl+C 或实际可投递的停止信号才走正常关闭。`v3-recovery` 已验证真实强杀、普通启动拒绝、错误 ID/活实例拒绝、原 Run 保留和原因落库。

### 继续实施

1. 核对所有未提交文件与当前类型检查；特别检查被中断的 Process bridge / Resource Host 工作，禁止把半成品注册成可用能力。
2. 完成宿主自动重连和外部结果协调；已有 Process bridge 取消/detach 专项、本地 Core 恢复、E4 审批及输出分页，不确定结果保留 UNKNOWN。
3. 完成跨 Slot Resource Host、资源身份/凭据映射和真实终止证据；没有可信证明时保持隔离。
4. 完成 Composition/Asset 的 Optional Host 接入，以及真实 Agent Provider 与完整权限撤销闭环；后台 Workflow 调度已接入。
5. 继续技术方案 M3/M4/M5/M9 的 OS 隔离、PTY/SSH、隔离工作树、Operator/Reviewer、安装升级回滚与恢复工具。
6. 加密、保留/清理、容量、性能与故障演练，逐条更新方案 §34/§35 的验收映射。
7. 用户提供环境后做 Linux/SSH、MATLAB、硬件和多设备验证；当前不宣称这些验收通过。

完整 V3 的完成条件仍以技术方案 §38 为准。当前可以确认本机核心链路及多组模块测试已通过，**不能确认完整 V3 已完成**。

## 10. 执行环境历史记录

### 隔离后端探针（新增实验，未启用生产执行）

本机为 Windows 11 家庭版；Windows Sandbox 不可用，Docker daemon 不可达。已有运行中的 Ubuntu WSL2 提供 bubblewrap 0.11.1。一次性临时命名空间实验通过 Workspace 写入、Reference/Runner 只读、越界链接拒绝、隐藏 Windows 挂载与 interop 路径、清空环境、无新增权限、能力清零、网络命名空间、宿主 loopback 拒绝及子进程继承等 11 项检查。

没有安装/启用系统功能、启动 Docker、修改已有账户/ACL/防火墙/服务。WSL 本身不是沙箱；PE/binfmt、interop/vsock 逃逸、受保护 Runner、预算和持久宿主整合仍需验证。生产隔离 backend 继续返回 UNAVAILABLE，Core 的 `osSandbox=false` 保持真实。探针不能作为启用强隔离的许可。

2026-09-29，自动审批审查服务因账号用量上限未能批准一条新增读取命令，同时一个协作执行也收到用量限制。服务明确说明这属于审查未完成，不是安全性判定。已启动的统一测试仍收取成功结果；未尝试绕过审批。

随后协作执行报告正常审批成功；主执行也通过同一正常审批流程重新读取文件成功，已恢复开发。没有变更或绕过审批机制。若再次出现相同限制，应保留源码和已运行证据，等待执行条件恢复，不用“全部完成”结束未完成工作。
