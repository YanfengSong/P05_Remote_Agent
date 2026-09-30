> **2026-09-30 T04/T08/T18/T65 验收闭环**
>
> - T04：新增受保护 bootstrap trust manifest 验证与 diagnostics-only LOCKED 启动路径；配置的 manifest 缺失、未保护、非法或绑定不匹配时不会启动执行后端。
> - T08：新增持久 Lifecycle Restart、RPC ackBarrier、v3-main supervisor 重启、重连健康 receipt 与幂等防重复重启验收。
> - T18：审批可跨 pre-dispatch 等待保留；dispatch reservation 持久化后进入 UNKNOWN 时不能退款或重复消费审批。
> - T65：Application 启动时强制注册 Capability 与 effect / execution identity / backend 安全元数据精确一致。
> - 当前矩阵：PASS 28 / PARTIAL 22 / NOT_RUN 20 / N/A 0。
> - 完整 npm run verify:v3 已于 2026-09-30 本机通过，覆盖类型检查、构建、V2 兼容回归、默认 V3 全套测试与 T01–T70 验收矩阵门禁。
> **2026-09-29 T03/T06/T13/T17/T20 验收闭环**
>
> - T03：broken optional/workflow catalog 明确进入 DEGRADED，同时 Core liveness 与最小读路径保持可用。
> - T06：64 路 reconcile flood 不重复启动；重复崩溃触发并锁定 CRASH_LOOP restart budget。
> - T13：event cursor 支持重连续读，Operator 与 MCP/Edge 对终态版本和结果保持一致。
> - T17：pending approval 期间 workspace/input/binding 被固定，替换 binding 或外部目标变化不会重定向原意图。
> - T20：即使审计 events 被删除，持久 Run 与 execution receipt 仍独立保持终态真相。
> - 当前矩阵：PASS 24 / PARTIAL 26 / NOT_RUN 20 / N/A 0；完整 npm run verify:v3 已于 2026-09-29 再次通过。
> **2026-09-29 验证门禁补强**
>
> - verify:v3 现定义为统一本机源代码门禁：类型检查、单次构建、V2 完整兼容回归、V3 默认全套测试以及 T01–T70 追踪矩阵完整性检查。
> - v3-component-host、v3-isolation（默认 fail-closed inventory，不自动运行 WSL POC）和 v3-terminal 已纳入统一门禁。
> - 2026-09-29 本轮补强后的完整 verify:v3 已通过；统一门禁通过不等于完整 V3，PARTIAL/NOT_RUN 仍须按技术方案 §34 单独关闭。
> - T01–T70 的当前证据与缺口记录在 V3_ACCEPTANCE_TRACEABILITY.md。
>
# V3 实施记录

> **2026-09-29 最新核对（优先于下方历史更新）**
>
> - 当前开发分支为 `v3`；本轮重新执行 `npm run check` 通过。实现仍未提交、未发布部署。
> - 最近一次完整 V3 验证通过 17 组测试；V2 完整回归已通过。此结果早于最新 Component bridge 和进程对账修改，不代表这些修改已通过整体验收。
> - 独立 Component Host 已通过 28 项真实子进程测试；Core 只读 E0 bridge 已实现，端到端接入测试待补。
> - 独立 Terminal Host 已使用项目内 node-pty 1.1.0 通过真实 Windows ConPTY 验证，覆盖输入、resize、输出分页、到期、取消和崩溃 UNKNOWN；Core 审批接入尚未完成。
> - 进程 UNKNOWN 对账的内部接口已实现并通过类型检查；操作员 API/CLI 接入及对账竞态测试尚未完成。
> - 当前处于“核心链路可运行、扩展模块集成中”。完整 V3 尚未完成；OS 强隔离、SSH、实际 Agent Provider、MATLAB/硬件整合、安装升级回滚及控制台仍有开发或验收缺口。
> - 项目配置、启动方式、凭据位置和恢复说明见 [本机开发交接](../handoff/V3_LOCAL_DEVELOPMENT_HANDOFF.md)；最新独立宿主配置另见 [Component Host](../../src/v3/component-host/README.md) 和 [Terminal Host](../../src/v3/terminal/README.md)。

> **2026-09-29 进展更新（以本段为最新状态，后文初始记录保留供追溯）**
>
> 具体配置、启动命令、凭据位置、验证证据及未完成项见 [V3 本机开发交接](../handoff/V3_LOCAL_DEVELOPMENT_HANDOFF.md)。
>
> - V2 全套回归已通过，包括策略、工具暴露、Reviewer、文件/Git、Operator、输出 schema 和插件兼容。
> - 一轮完整 `npm run verify:v3` 退出 0，覆盖类型检查、构建和 12 组本机测试。Core 46 checks、资源 53 checks、组件 53 checks。
> - 已接入实际 MCP Edge、持久执行、审批原 Run 恢复、文件/Git、三阶段 Workflow 后台自动推进和重启续跑。无商业 Agent Provider。
> - 独立 Process Host 及桥接专项通过；随后 Application 的 HostExecute 独立审批、唯一副作用与输出分页也通过。新脚本已纳入 bridge，后续改动需重跑。
> - 状态 ACL/所有者/链接负测已完成；当前仍为 trusted-host，未实现 OS 文件/网络沙箱或加密 PayloadStore。
> - Resource Coordinator 的独立跨 Slot 服务已完成 30 项测试；Composition/Asset 生产宿主接入仍未全部完成。后台 Scheduler 24 checks、Core 当前 54 checks；配置初始化和显式本机恢复 CLI 已测。PTY/SSH、并行写隔离、安装升级回滚、完整 V3 控制台等继续开发。
> - 用户指定先本机验证，Linux/SSH、MATLAB、硬件实机环境稍后提供；适配未实现与未实机验收分别记录。
> - 完整 V3 尚未完成，交付条件仍以技术方案 §38 为准。原 V2 未提交改动保持不动，当前 V3 实现未发布部署。

## 初始实施记录（历史）

基线日期：2026-09-29。依据：[完整技术方案](../architecture/P05_V3_TECHNICAL_SOLUTION.md)。

用户授权按方案开发并在完成后验证。本文件记录实际进展，不将接口、预览或局部测试通过视为完整 V3 交付。

## 开发基线

- 开发分支：`v3`，在独立工作树中实施。
- 已合入 V2 已提交修复 `3ebd9a6281f0a030add1c29e0bfcc2ddd8964ff9`；原工作目录的未提交改动未复制、未覆盖。
- Node：24.19.0；内置 SQLite 探针：3.53.3。采用内置驱动进行 P02 实验，避免提前增加原生依赖。
- `npm ci --offline` 完成；初次类型检查和构建通过。
- 首次基线验证在 Get-FileHash 处失败：继承的 PowerShell 7 模块路径污染 Windows PowerShell 5.1。正在补进程级环境修复与回归。

## 阶段状态

| 阶段 | 当前状态 | 出口 |
|---|---|---|
| M0 基线、合同、实验 | 进行中 | 现有回归通过、基线固定 |
| M1 Core/Slot | 进行中 | 独立身份/所有权、最小恢复、可选层降级 |
| M2 持久执行与审批 | 进行中 | 稳定 ID、持久事务、等待/审批/重启恢复和接入验证 |
| M3 实际隔离与权限后端 | 未完成 | OS 文件/网络/身份负测 |
| M4 Process/Terminal/SSH | 未完成 | 长进程与远端回执闭环 |
| M5 资源与工作隔离 | 未完成 | MATLAB/资源 fencing、worktree 整合 |
| M6 插件与组件 | 未完成 | v1 兼容、Binding、依赖 drain |
| M7 Agent/Skill/Asset | 未完成 | Provider 与可验证 Skill |
| M8 Workflow | 未完成 | 有界阶段与恢复、取消、并行整合 |
| M9 控制与发布 | 未完成 | Operator/Reviewer、升级回退 |
| M10 Linux/多设备 | 未完成 | 真实目标平台合同测试 |
| M11 全量验收 | 未完成 | §34 全部适用验收和运维演练 |

## 验证规则

新测试使用临时目录、测试进程和独立端点；不接管已部署 A/B，不重启用户 MATLAB、远程主机或其他应用。需要真实设备或高权限安装的项单独记录证据与前置条件。

每一轮完成后更新本文件的命令、结果和限制。完整交付条件以技术方案 §38 为准。
