# 本地 Agent 交接：A1 带版本的范围读取

交接日期：2026-10-26
接手动作：在已有实施分支开发 A1，验证后提交。用户已授权开发；本次因用户选择交给本地 Agent，当前 Agent 停止实施。

## 1. 先确认项目和分支

- **唯一项目目录：** `D:\Project_Git\P05_V2_Deployment`。
- **实施分支：** `codex/v2-agent-workflow-pilot`，已跟踪同名 origin 分支。
- **交接前 HEAD：** `d143098ad3a1b12c47517b5271019a6f086dacc3`，内容为方案文档。
- **交接前工作区：** 干净。本轮只读了代码，尚无功能代码修改、测试文件或新测试结果。
- 默认会话目录 `D:\Project_Git\P05_Remote_Agent` 是旧项目，不要在那里实施。
- 使用 `C:\Users\EDY\.codex\RTK.md` 的规则：所有 shell 命令以 `rtk` 开头。
- 在当前分支继续；先检查是否出现用户或其他 Agent 的新改动，保留它们。

## 2. 用户意图与本次范围

用户明确说明：当前目标是让 MCP 工具更好用、更可靠，使远端更方便地操作本地文件。效率改善是收益，不要求立即把二十分钟任务缩短到某个目标，也不要先开展大规模性能研究。

本次接手完成 **A1：带版本的范围读取**。完成后报告实现、验证和提交，不自动启动阶段 B。A2 多编辑、A3 搜索/审计契约、A4 综合基准已有计划，后续可继续。

不要重复开展外部项目调研，也不要重写整体方案。无需为已经授权的 A1 开发再次确认。

## 3. 先读这些文档

1. [阶段 A 实施计划](../superpowers/plans/2026-10-26-mcp-file-contracts.md)：执行 A1。
2. [总体设计](../architecture/V2_AGENT_WORKFLOW_PILOT.md)：重点 R01—R04、第 6 节 A1。
3. [ADR-0022](../adr/ADR-0022-v2-agent-workflow-pilot.md)：方向与边界。
4. [阶段 B 计划](../superpowers/plans/2026-10-26-local-agent-pilot.md)：仅作后续参考，本次不实施。

执行计划已经选择当前会话顺序实施；不需要为 A1 新建 worktree 或另一条分支。

## 4. A1 要交付的行为

保留现有 `fs_read_many({paths:[...]})` 的旧行为、成功输出字段和限制。增加显式 V2 输入：

```json
{
  "contract_version": 2,
  "requests": [
    {"path":"src/index.ts","offset":0,"limit":120}
  ],
  "max_bytes": 65536
}
```

- paths 与 requests 互斥；requests 必须带 contract_version:2。
- 每批 1—20 项；offset 是从 0 开始的行偏移；limit 为 1—2000 行；路径最多 1024 字符。
- max_bytes 默认 64 KiB，最小 4096，最大 256 KiB。
- 新响应包含每项原始字节 SHA-256、totalLines、实际范围、text、complete、nextOffset，以及批次 pendingIndexes。
- 后续请求可传 expected_sha256；版本变化返回冲突，避免把不同文件版本拼在一起。
- CRLF 原样保留；空文件 0 行；末尾换行不额外产生空行；BOM 从展示移除，但 hash 必须包含原始 BOM。
- UTF-8 严格解码，拒绝二进制和无效编码；读取必须有界。
- 普通文本客户端也要能看到文件正文、版本与续读信息。
- 预算计算最终 MCP 工具结果对象的 JSON UTF-8 大小，包含 content 和 structuredContent 的重复正文；不只是原始 text 字节数。
- 单项失败不能阻止其他独立文件返回。错误使用固定、简短的 code/message，不暴露解析后的宿主绝对路径。
- 截断必须能前进：文件内未读范围使用 nextOffset，未处理请求使用 pendingIndexes。单行无法容纳时明确错误，不循环返回同一个无进展游标。
- schema 保持 MCP 要求的顶层 object；旧客户端不能因新分支而退化。

## 5. 已核对的实现位置

| 文件 | 当前情况及接手注意点 |
| --- | --- |
| `src/tools/register-fs.ts` | fs_read_many 目前只接收 paths，每批 20 文件，文本合计 1 MiB；开始时固定 currentRoot。可在这里分派新/旧输入，保留旧分支。 |
| `src/tools/files.ts` | readTextFile 通过 assertAccessiblePath 检查，按 config.maxReadBytes 限制，再按 UTF-8 读取；其返回字符串不足以提供严格的原始字节快照。新读取宜放独立模块。 |
| `src/security.ts` | assertAccessiblePath(input, "read", baseDir, workspaceRoot) 已处理工作区边界、保护路径、链接真实路径。必须复用；.p05/.git/.env 等不能通过新接口读取。现有策略明确仍有 hardlink/TOCTOU 局限，不宣称新读取消除了这些风险。 |
| `src/config.ts` | config.maxReadBytes 默认 **2 MiB**，可配置。设计中的 8 MiB 应视为新读取硬上限，不能绕过本地更小的限制；建议取两者较小值，并更新文档说明。非法限制值要失败关闭。 |
| `src/tools/result.ts` | structuredResult 返回 content + structuredContent；默认文本是 pretty JSON，调用方可提供文本。新预算要测最终对象。 |
| `src/policy/expose.ts` | 统一授权、profile、审批、runtime 包装。新读取保持注册到原工具，不开旁路。 |
| `src/runtime/execution.ts` | 当前只有抛异常才把审计记失败；返回带错误的结构化结果可能仍被记为 succeeded。A3 原计划处理统一映射。A1 若引入 isError，需要明确测试其审计语义，避免错误被误报成功；不要无必要重构整个 runtime。 |
| `src/capability/registry.ts` | fs_read_many 描述需同步更新；风险仍为 read，scope 仍为 workspace。 |
| `src/test/output-schema.ts` | 真实 stdio MCP 客户端测试；检查每工具 outputSchema 根为 object，已有两组 legacy fs_read_many 调用。适合加入 V2 请求与实际返回预算断言。 |
| `src/test/profile-exposure.ts` | 检查 profile/tool 暴露，新增输入不能扩大权限。 |
| `package.json` | build/check/test:compiled/verify 已存在；把新 file-contracts 测试加入 test:compiled。 |

计划新增：
- `src/tools/file-contracts.ts`：输入/输出类型、schema、限制。
- `src/tools/read-ranges.ts`：受限缓冲区、严格解码、范围读取、版本。
- `src/tools/result-budget.ts`：实际响应字节统计与裁剪。
- `src/test/file-contracts.ts`：功能、边界、错误和兼容性验证。

## 6. 建议的实施顺序

1. 读取 A1 原计划，检查当前分支是否仍为交接基线。
2. 先写关键失败测试并运行，确认失败来自尚未实现的行为。
3. 实现读取与预算模块，接入原工具的显式 V2 分支。
4. 通过真实 MCP 客户端验证 schema、文本可见性和最终序列化预算。
5. 跑相应现有回归检查，修复后记录真实结果。
6. 更新 A1 复选框和实现说明，提交到当前分支；提交消息可使用：
   `feat: add versioned range reads with bounded MCP results`。
7. 报告已完成范围与后续 A2；本次不重启运行中 Runtime、不自动合并、不启动真实 Codex 委派。

读取实现应先限制分配与读取量；不能先无限 readFile，再检查大小。hash、展示内容和行数应来自同一次受限读取。需区分同文件版本检查与 OS 文件系统 CAS，后者不在本次承诺中。

对预算建议采用整行裁剪和有界搜索，避免逐字符或逐行反复序列化整个大结果。优先保证结果正确和可续读，再做微优化。

## 7. 必须覆盖的测试

- 空文件、末尾换行、CRLF、中文、BOM。
- 无效 UTF-8、二进制、目录、缺失文件、超文件大小限制。
- 陈旧 expected_sha256、分页期间文件修改。
- 路径越界、保护文件、链接指向工作区外。
- legacy 调用行为保持，混用 paths/requests 拒绝。
- 默认/最小/最大预算；中文与 JSON 转义产生的额外字节；单行超预算；20 个长路径造成 metadata 超预算。
- 多文件部分失败，其余文件仍可读；pendingIndexes 与 nextOffset 指向真实未返回内容。
- 文本客户端能看到正文与版本；结构化字段通过 MCP schema 检查。
- 每个有效的新请求返回最终 MCP 结果不超过所选 max_bytes。输入被 SDK 拒绝时的协议级验证错误与工具有效响应预算分开说明。
- 读取 hash 可用于既有补丁接口：既有 patchTextFile 使用 UTF-8 解码后重新编码 hash，严格有效 UTF-8（包括保留 BOM 的字符串）应保持字节一致；用测试证明，不凭假设。
- 若改动执行结果分类，加测试证明错误审计为失败、成功与只读截断没有错误分类。

## 8. 命令与环境提示

以下命令均在唯一项目目录执行：

```powershell
rtk git status --short --branch
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts.js
rtk proxy .p05/tools/node/node.exe dist/test/output-schema.js
rtk proxy .p05/tools/node/node.exe dist/test/profile-exposure.js
rtk proxy git diff --check
```

- 新测试若导入 config.ts，应在导入前为测试进程设置明确的 REMOTE_AGENT_ALLOWED_ROOTS / REMOTE_AGENT_DEFAULT_CWD，或使用独立子进程。不得改写真实 .env。
- 测试使用自建临时 fixture，清理前确认绝对路径仍在该 fixture 根内。
- 本机内置 Node 已验证为 v22.23.1；无需安装新生产依赖。
- 本轮没有执行编译或测试；不要把历史检查结果当作新实现已通过。
- Windows PowerShell 5 的 Get-Content 默认编码会把 UTF-8 中文显示成乱码；读文档请显式 `-Encoding UTF8` 或使用 `[IO.File]::ReadAllText`。原文档已验证为有效 UTF-8。
- 历史测试遇到继承的 PSModulePath 隐藏系统模块。确有此问题时仅修改测试进程的 PSModulePath 到系统 WindowsPowerShell/v1.0/Modules，避免动用户全局设置。
- rtk git diff --check 曾过滤掉诊断；需要原始信息时使用上面的 rtk proxy git diff --check。
- 最后若执行 npm run verify，先确保该进程 PATH 使用项目内置 Node/npm；如分项通过而完整 verify 未跑通，报告中明确区分。

## 9. 完成报告

说明新增调用方式、兼容情况、实际运行的测试及结果、未完成项与提交 hash。用户关注工具是否好用，不需要未经测量的提速百分比，也不需要再次提议整体调研。
