# MCP File Contracts Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本项目采用本地 Agent 顺序执行；未获用户另行授权不派生子 Agent。本计划是修复交接，不表示任何任务已经实施。

**Goal:** 修复 A1—A4 独立审查确认的正确性与契约问题，使文件操作结果、预算和验证证据可信。

**Architecture:** 保留现有工具与显式 V2 分支，提取小型共享 I/O 原语，集中生成最终响应和错误语义。每个任务独立回归、提交；不重构整个工具系统，不推进阶段 B。

**Tech Stack:** 项目内置 Node v22.23.1、TypeScript、Zod v4、MCP SDK v2、node:assert/strict；无需新生产依赖。

**Spec:** [原方案](../../architecture/V2_AGENT_WORKFLOW_PILOT.md)、[独立审查报告](../../validation/MCP_FILE_CONTRACTS_REVIEW_2026-10-27.md)、[阶段 A 原计划](2026-10-26-mcp-file-contracts.md)。

## Global Constraints

- 唯一实施目录：`D:\Project_Git\P05_V2_Deployment`；分支 `codex/v2-agent-workflow-pilot`。
- 功能代码审查终点：`7d491b9e433ee903a7b83ece0be55612d0cd6791`。之后如只有审查文档提交，在其上继续；若有新功能改动，先核对差异并保留他人工作。
- 默认正文预算 64 KiB，硬上限 256 KiB（新契约序列化后的整个 MCP 结果 UTF-8 字节，含重复正文和信封）。
- 路径、workspace、profile、审批和审计沿用现有控制点。不能以统一错误为由删除保护策略。
- 文件版本使用原始字节 SHA-256；不承诺跨文件事务或通用文件系统 CAS。
- 旧工具名和成功响应保持兼容；保留已实施的重叠歧义拒绝，并将其记录为安全性行为变化。
- 不读取真实凭据、不改真实 .env、不重启 Runtime、不推送/合并、不启动阶段 B。
- 所有 shell 命令以 `rtk` 开头；每任务使用隔离 fixture；递归清理前验证绝对路径范围。
- 确定性 I/O 故障注入仅用于测试依赖，不能从 MCP 参数启用。
- 测试先确认旧代码会失败，再实现；不能用恒真断言或打印常量代替验收。

## 任务及依赖

| 任务 | 交付 | 依赖 |
| --- | --- | --- |
| M1 | A1最终预算与失败聚合正确 | 无 |
| M2 | 有界一致性检查、完整写入、诚实失败 | 无；先于M3/M5 |
| M3 | 缺失祖先路径锁及锁内批量预检/dry_run | M2 |
| M4 | search/patch最终预算与有界预览 | M1预算原语 |
| M5 | 路径错误结构化与脱敏 | M2、M4 |
| M6 | 无全文件行数组的读取/搜索 | M2 |
| M7 | 端到端审计、真实重试指标、文档与总验收 | M1—M6 |

按 M1→M2→M3→M4→M5→M6→M7 执行；每任务单独提交。不要把修复全部堆成一个难审查的提交。

## 文件与测试入口

主要修改：
- `src/tools/read-ranges.ts`、`result-budget.ts`、`result.ts`、`file-contracts.ts`。
- `src/tools/files.ts`、`file-write-lock.ts`、`register-fs.ts`。
- `src/runtime/execution.ts`，以及必要的 audit/公开 schema。
- `src/test/file-contracts.ts`、`output-schema.ts`、`profile-exposure.ts`、`file-contracts-benchmark.ts`。

计划新增：
- `src/tools/file-io.ts`：受限快照、身份/稳定性检查、完整写入原语。
- `src/tools/text-lines.ts`：不物化全文件行数组的计数/范围/迭代。
- `src/test/file-io.ts`：短写、零进展、增长/替换等确定性 I/O 故障。
- `docs/validation/MCP_FILE_CONTRACTS_REMEDIATION.md`：问题关闭证据与最终执行记录。

通用命令：
```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts.js
rtk proxy .p05/tools/node/node.exe dist/test/output-schema.js
rtk proxy git diff --check
```
新增 file-io 测试加入 test:compiled。config 的测试环境在导入前设置；保持真实 .env 不变。

## M1. 预算最终化与失败聚合

**问题：** 报告 E1/E2、单项策略错误被降为 READ_FAILED/safe。
**Files：** read-ranges.ts、result-budget.ts、file-contracts.ts、runtime/execution.ts、file-contracts 测试、output-schema 测试。

**接口要求：**
- 保留 `readManyRanges(root, requests, maxBytes)` 及旧 paths 分支。
- 新增内部 `finalizeReadResult(items, pendingIndexes, maxBytes)`，输出仍为 ReadManyResult。
- 以最终相同的 `{content, structuredContent, isError?}` 对象计量；不能在预算通过后追加 pending、错误文案或 isError。
- 所有响应均经过一个最终化出口。

- [x] 把独立报告 E1/E2 fixture 转为失败断言。E1 使用36行文件，首请求取35行且结果接近4096字节，随后长路径失败请求进入pending；不能只测试EOF完整项。
```ts
assert.ok(toolResultBytes(reply.result, reply.contentText,
  isOutcomeFailure(reply.result.outcome)) <= 4096);
assert.equal(isOutcomeFailure(mixed.result.outcome), true);
assert.equal(mixed.result.failureCount, 1);
assert.deepEqual(mixed.result.pendingIndexes, [1]);
```
reply/mixed 分别来自 E1/E2 真实 readManyRanges 调用，不能预置为期望值。

- [x] 加单项 PATH_REFUSED、READ_LIMIT_INVALID、STALE_REVISION 以及“成功+失败+pending”的测试。先运行并确认边界测试在旧实现失败。
- [x] 实现聚合顺序：先看失败，再看是否只截断。单项失败或全部同码失败使用固定 outcomeFor(code)；混合失败保留逐项 code，顶层 READ_PARTIAL/READ_FAILED 的 retry 取最保守值。
```ts
const rank = { safe: 0, after_refresh: 1, never_automatic: 2 } as const;
const retry = failures.map(item => fixedOutcomeFor(item.errorCode ?? "READ_FAILED").retry)
  .reduce((left, right) => rank[left] >= rank[right] ? left : right, "safe");
```
未知读取错误的 effectState 始终 none，不把只读错误误写成已发生未知写入。权限拒绝与本地配置错误不能被标 safe 自动重试。

- [x] 最终结果超预算时，先在末尾成功项按整行裁剪；必要时将整个末尾项移回 pending 并保持输入索引有序无重复。若移除了失败项，不应假装已成功处理；该索引必须pending。没有任何可前进结果时返回固定有界 RESULT_BUDGET_TOO_SMALL。
- [x] 计量要覆盖 outcome 从失败/成功切换、索引位数、长路径、JSON转义与 isError。不得反复返回同 nextOffset；不要为修字节数丢失最后一行或跳过请求。
- [x] 审计 resultTruncated 从实际 pending/文件未完成/响应截断状态计算，不能只看 code。一个批次可以同时 failed 和 truncated。
- [x] 通过真实 MCP 测试后查询 activity_recent/recovery_status：混合失败应 failed，保留错误与pending；正常截断应 succeeded。
- [x] 提交：`fix: finalize read budgets without masking item failures`。

**M1 实施记录（2026-10-27）：** 新增 E1（4098→≤4096）、E2（失败不被 pending 掩盖）、单项 PATH_REFUSED/READ_LIMIT_INVALID/STALE_REVISION、成功+失败+pending、混合失败 retry 最保守值和审计 truncated 断言；`readManyRanges` 的所有出口统一走 `finalizeReadResult`，失败优先于截断，最后按整行裁剪/移回 pending。`file-contracts` 392 项检查通过；output-schema 257、profile-exposure 266、foundation 58 通过。

## M2. 共享有界快照与完整写入

**问题：** E3/E4、本地自查2/3/4；同时减少同类 I/O 语义分叉。
**Files：** 新建 file-io.ts、src/test/file-io.ts；修改 files.ts、read-ranges.ts、package.json、file-contracts.ts。

**接口：**
```ts
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
export type FileSnapshot = { bytes: Buffer; stat: BigIntStats };
export function readBoundedSnapshot(handle: FileHandle, limit: number): Promise<FileSnapshot>;
export function writeAllAtStart(handle: FileHandle, bytes: Buffer): Promise<void>;
```
调用方管理句柄的打开/关闭。新 FileIoError 带固定 code，远端映射不包含原始 OS error.message。

- [x] 新增短写（每次最多3字节）、零进展、写到一半抛错、sync失败、回滚短写、读取期间增长/缩短/同尺寸修改的测试；每个故障有明确触发次数断言。
```ts
assert.equal(committed.status, "committed");
assert.deepEqual(await fs.readFile(target), expectedBytes);
assert.equal(committed.files[0].sha256, sha256(expectedBytes));
assert.notEqual(zeroProgress.status, "committed");
assert.equal(interrupted.outcome.retry, "never_automatic");
```
committed 使用最终能完成的多次短写；zeroProgress/interrupted 是独立 fixture，后者已发生部分写入且不能确认原样恢复。

- [x] 实现完整写入循环，并对返回计数作零进展/非法值检查：
```ts
let offset = 0;
while (offset < bytes.length) {
  const remaining = bytes.length - offset;
  const { bytesWritten } = await handle.write(bytes, offset, remaining, offset);
  if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
    throw new Error("WRITE_INCOMPLETE");
  }
  offset += bytesWritten;
}
```
生产实现将该固定错误转为 FileIoError。提交和回滚都用同一原语；不得因部分写入以预期 buffer 的 hash 冒充实测成功。

- [x] readBoundedSnapshot 在分配前验证 limit 为安全非负整数，检查常规文件和 size；按明确位置读取，不读超过limit；短读、额外EOF探测发现增长、前后 size/mtimeNs/ctimeNs/dev/ino 改变都报不稳定。保留残余的同字节/同元数据竞争限制。
- [x] 本地 config.maxReadBytes/maxWriteBytes 验证为安全正整数。V2读取使用 min(config,8MiB)；legacy不擅自收紧正常配置的原额度；batch预检在分配前同时应用剩余8MiB总快照额度。
- [x] 将批量预检、readHandleAtStart、回滚新文件检查、legacy readTextFile 的 stat+readFile 换成有界读取。后者由搜索复用，不能只修新范围读取而留下搜索无限读取入口。保持既有UTF-8行为差异和路径策略，勿隐式更改legacy解码契约。
- [x] 新建文件使用 `wx+` 以同时保留排他创建与同句柄读回能力；既有文件保持r+。写完sync后从同句柄读取并核对长度/hash；尽可能核对路径与句柄的文件身份。在判定整个批次committed前复核各目标的可观察状态。
- [x] 任何已触碰文件效果无法确认时保留现场并返回 unknown/never_automatic。不能仅因当前内容是预期前缀就认定可安全恢复。未经触碰的预检失败为none；成功恢复须实际验证原始hash。
- [x] 增长发生在最终读取期间的 E4 应拒绝或unknown且保留外部追加；增长发生在最后检查之后仍有残余窗口，不能把多做一次stat当作OS锁。
- [x] 提交：`fix: bound file snapshots and verify complete batch writes`。

**M2 实施记录（2026-10-27）：** 新增 `file-io.ts`（`readBoundedSnapshot`、`writeAllAtStart`、`validatePositiveFileLimit`）及 19 项 `file-io` 故障测试；批量预检、提交、回滚、新文件清理和 legacy `readTextFile` 均改用有界读取，完整写入循环拒绝零进展/非法短写。提交写入后从同句柄读回并核对长度/hash 及路径身份，新文件使用 `wx+`。E3/E4 短写、零进展、中断、sync 失败和最终读取期间外部追加测试均通过；`file-contracts` 407 项、file-io 19 项、output-schema 261、profile-exposure 266、foundation 58 通过。

## M3. 规范路径锁与锁内预检

**问题：** E7；dry_run稳定性改进。
**Files：** file-write-lock.ts、files.ts、file-contracts测试。

- [x] 用临时内部junction/symlink建立 real 和 alias，两级父目录缺失；证明锁key相同。加入受控barrier测试，两个key上的临界区不能重叠，不以时间sleep判断。
```ts
assert.equal(
  await canonicalWriteKey(path.join(root, "alias/new/nested/file.txt")),
  await canonicalWriteKey(path.join(root, "real/new/nested/file.txt"))
);
assert.equal(maxConcurrentInCriticalSection, 1);
```
maxConcurrentInCriticalSection 由实际进入/退出锁回调累计。

- [x] canonicalWriteKey 逐级寻找最近存在的祖先，对其realpath，再按原序拼回缺失段；Windows保持大小写规范化。只有ENOENT/ENOTDIR等符合“尚不存在”的情况可向上解析，EACCES/循环链接/无法解析要失败关闭。
- [x] 批量先无副作用做策略与key解析，排序获取锁；锁内再执行权威预检、读取与生成候选。dry_run也在同一临界区内生成结果；commit复用已经持有的锁，避免重复获取死锁。
- [x] 锁内发现路径解析结果改变则拒绝/释放重试，不边持有旧key边随机获取新key。先保持一套清晰的锁所有权，不能让legacy与V2分别有自己的Map。
- [x] 验证四个写入口、重复目标、异常释放、反向多路径请求和dry_run并发。外部进程仍不受此锁约束。
- [x] 提交：`fix: canonicalize missing ancestors for shared file locks`。

**M3 实施记录（2026-10-27）：** `canonicalWriteKey` 改为逐级 realpath 最近存在祖先并拼回缺失段，ENOENT/ENOTDIR 才继续，其他错误失败关闭；新增 alias/real 两级缺失父目录 key 相等、同 key barrier、异常释放和 dry_run 等待共享锁测试。批量 legacy/V2 都通过同一个 `withBatchLocks` 先解析 key、排序加锁，再在锁内做权威预检/读取/候选；commit 复用已持有锁，不再二次获取。`file-contracts` 414 项检查通过。

## M4. 将 R03 落实到 search 与 patch

**问题：** E5/E6，全局契约缺失。
**Files：** file-contracts.ts、result-budget.ts、register-fs.ts、files.ts、patch-edits.ts、对应测试和规格。

**接口决策：**
- V2 fs_search、apply_patch_many 新增可选 `max_bytes`，沿用4096—262144和默认65536；legacy不能接受该字段。
- V2响应返回实际使用的max_bytes；增加 `responseTruncated` 说明响应内容被裁剪，patch的diff可增加 `previewTruncated`。不新增工具、不增加搜索快照游标。
- 最终化基于实际MCP对象计量，与M1共用计量原语，不复制第三套字节估算。

- [x] 将handler-probes的中文搜索、JSON转义patch预览变成真实MCP预算测试，覆盖默认/最小/最大预算。
```ts
assert.ok(Buffer.byteLength(JSON.stringify(searchResult), "utf8") <= 65536);
assert.ok(Buffer.byteLength(JSON.stringify(patchPreview), "utf8") <= 65536);
assert.equal(patchPreview.structuredContent.files.length, 20);
```
三个变量均来自真实调用；再增加强制4096和262144边界，不只跑默认值。

- [x] 搜索裁剪以完整match/snippet为单位，保持真实已扫描统计与已观察命中统计；增加明确的返回数量/responseTruncated。coverage描述扫描是否完成，responseTruncated描述响应是否完整，两者不要混用。错误+裁剪仍是错误，不被SEARCH_TRUNCATED掩盖。
- [x] 搜索无游标时nextAction指导缩小path/query或提高预算；不能声称被裁掉的命中不存在。内容预算要包含给纯文本客户端的说明/命中内容。
- [x] patch只裁剪可选diff预览/冗长文案，**不丢弃任何目标的执行状态、版本和失败效果**。所有会执行的目标必须留得下最小必要结果。
- [x] 在任何mutation前，按各目标必要元数据和有限错误码，预留成功、回滚、unknown等最坏结果信封；必要结果放不下时，先返回RESULT_BUDGET_TOO_SMALL且effectState=none，文件字节零改变。
- [x] 写入后不允许因为响应预算失败而重试、回滚、返回“未执行”，或把已执行目标放pending。实际诊断采用固定有界错误码/文案；预算只可压缩可选展示。最终出口再次验证始终<=max_bytes。
- [x] 预览被裁剪而候选计算完整时可保持dry_run completed，但必须明确previewTruncated；不要把展示不全误报执行失败。
- [x] 更新outputSchema/profile描述，确认新增参数仍参与现有审批指纹，不绕过授权。
- [x] 提交：`fix: enforce final response budgets across V2 file tools`。

**M4 实施记录（2026-10-27）：** V2 `fs_search`/`apply_patch_many` 增加可选 `max_bytes`（4096—262144，默认65536），legacy schema 拒绝该字段；响应返回实际 `max_bytes`、`responseTruncated`、搜索 `returnedFiles/returnedMatches`，patch diff 增加 `previewTruncated`。搜索按完整 match 前缀二分裁剪，coverage 与 responseTruncated 分离，错误 outcome 不被裁剪掩盖；patch 在任何 mutation 前用成功/失败 union skeleton 预留预算，不足时返回 `RESULT_BUDGET_TOO_SMALL` 且零写入，执行后只裁剪可选 diff/文案，所有目标状态和哈希保留。真实 MCP 测试覆盖中文 100×5 搜索的 4096/65536/262144 预算、20 文件 JSON 控制转义 dry_run 的三档预算、最小预算零写入和 `previewTruncated`；`file-contracts` 418 项、output-schema 303 项通过。

## M5. V2业务错误结构化与路径脱敏

**问题：** E8及自查5/9。
**Files：** files.ts、register-fs.ts、file-contracts.ts、write-target.ts（若需类型化错误）、output-schema/file-contracts测试。

- [x] 新增V2路径越界/保护路径/硬链接，以及搜索根不存在/非目录/符号链接/拒绝访问的fixture。文本与structuredContent不得包含测试根的解析后绝对路径。
```ts
assert.equal(result.isError, true);
assert.ok(result.structuredContent.outcome);
assert.equal(JSON.stringify(result).includes(fixtureRoot), false);
```
请求使用相对路径；保留用户自己明确传入的路径与泄漏解析后路径要分开判断。

- [x] V2 patch把前置write-target检查移入结构化异常边界，或调用共享的类型化策略预检。必须继续执行全部workspace/protected/hardlink检查；**不能直接删除安全检查**。
- [x] V2 search将根/业务输入错误映射为固定outcome。未开始扫描时coverage.complete=false、scannedFiles=0；增加明确 `stopReason:"not_started"`，不要把权限拒绝伪装为扫描io_error。普通扫描中I/O失败保留io_error及skip分类。
- [x] 固定错误表补齐NOT_DIRECTORY/INVALID_QUERY等实际代码，确认PATH_REFUSED为rejected/none/never_automatic；不得返回OS原始message/stack。
- [x] schema/协议级非法输入可以继续由SDK拒绝，无须冒充业务结果。认证与profile拒绝继续在原层阻断。legacy成功格式保持；对legacy原始路径泄漏作相同脱敏属于安全修正。
- [x] 增加readdir/stat/read的确定性失败注入、真实symlink/junction和oversized fixture。测试明确说明哪些是OSfixture、哪些是故障注入；不修改用户ACL来凑测试。
- [x] 提交：`fix: preserve structured V2 policy failures without leaking paths`。

**M5 实施记录（2026-10-27）：** V2 `apply_patch_many` 移除 handler 的前置 `assertWorkspaceWriteTarget`，由 `patchTextFilesBatchV2`/共享预检在结构化边界内继续执行 workspace/protected/link/hardlink 检查；越界、保护路径和硬链接均返回带 `outcome`/`errorCode` 的 V2 结果且不泄漏 fixture 绝对路径。V2 `fs_search` 对 missing root、非目录、symlink/junction root、EACCES 注入统一返回 `coverage.stopReason="not_started"`、`scannedFiles=0` 和固定 outcome（NOT_FOUND/NOT_DIRECTORY/PATH_REFUSED/ACCESS_DENIED），扫描中的 readdir/stat/read 失败仍为 `io_error`。新增真实 junction/oversized fixture 与 readdir/stat/read 确定性注入；legacy search root 错误也改为固定脱敏文案。`file-contracts` 456 项、output-schema 311 项通过；isError 结果的 structuredContent 显式过 Zod schema。

## M6. 约束派生行数据的内存

**问题：** 自查7；搜索也使用全文件split。
**Files：** 新建 text-lines.ts；修改 read-ranges.ts、files.ts及file-contracts测试。

**接口：**
```ts
export type LineWindow = { totalLines: number; text: string; returnedLines: number };
export function selectLineWindow(text: string, offset: number, limit: number): LineWindow;
export function* iterateLines(text: string): Generator<string>;
```
迭代行保留换行符，调用搜索处再按旧语义去除LF/CRLF。空文件0行、尾换行不生成额外空行。

- [x] 使用换行密集的有界fixture，读取末尾少量行，校验totalLines、offset和结果；保留中文/BOM/CRLF测试。
```ts
const window = selectLineWindow("\n".repeat(200_000), 199_998, 2);
assert.equal(window.totalLines, 200_000);
assert.equal(window.returnedLines, 2);
assert.equal(window.text, "\n\n");
```
- [x] 单次扫描统计总行数并记录请求窗口起止字符位置；只构造请求范围，不为全文件创建字符串数组。预算裁剪最多处理请求的2000行，也可用字符边界索引。
- [x] 搜索逐行迭代，保持line编号、大小写匹配、occurrences和matchesTruncated原语义；不能把纯重构引入计数变化。
- [x] 在独立子进程做接近8MiB的密集换行压力用例，设置受控heap上限并记录结果；不以精确RSS数值作脆弱断言，不在真实Runtime内制造OOM。
- [x] 提交：`perf: scan text ranges without materializing every line`。

**M6 实施记录（2026-10-27）：** 新增 `text-lines.ts` 的 `selectLineWindow`/`iterateLines`；`readRange` 只单次扫描并切出请求窗口，搜索按行迭代并在调用处去除 CR/LF，保持行号、occurrences 和 matchesTruncated 语义。新增 200k 密集换行、空文件、尾换行、CRLF、中文、无尾换行、逐行迭代和 CRLF 搜索计数测试；独立 Node 子进程以 64 MiB heap 处理 8 MiB 密集换行 fixture 成功，不依赖 RSS 阈值。`file-contracts` 472 项、output-schema 311 项通过。

## M7. 真实证据、端到端审计与收尾

**问题：** 自查8/9/10/11；确保以上缺陷有不可假通过的回归。
**Files：** file-contracts-benchmark.ts、output-schema.ts、file-contracts.ts、package.json、PROJECT_STATUS.md、原验证文档和新修复验证文档。

- [x] 给基准增加实际执行轨迹，最少记录tool、目标、expected hash、观测code、刷新得到的hash。由轨迹统计conflicts和unsafeRetries；删除字面true断言和硬编码conflicts=2。
- [x] 增加真实场景：读取旧hash→fixture外部改写→提交旧hash被拒→重新读取→用新hash修改成功。所有操作来自实际MCP调用；最后独立读取文件确认内容。
- [x] 负向校准指标：在隔离fixture中故意再提交一次已经被拒的旧hash，计数器必须得到unsafeRetries=1；正常驱动不得出现该重试。这里unsafe指不合规的重试尝试，不声称该尝试绕过了服务端hash保护。
```ts
assert.equal(metricsFor(safeTrace).unsafeRetries, 0);
assert.equal(metricsFor(deliberatelyStaleRetryTrace).unsafeRetries, 1);
assert.equal(metricsFor(safeTrace).conflicts, observedConflictResponses);
```
metricsFor是新增的纯轨迹汇总函数；safeTrace和故意重试trace由真实fixture调用产生。legacy冲突通过明确的fixture断言分类，不把任意异常都计为版本冲突。

- [x] 真实MCP失败后再查询activity_recent/recovery_status，按capability与唯一调用标识/事件ID关联，不因查询自身产生事件而误取“最新一条”。覆盖单项策略错误、错误+pending、正常截断和unknown写入。
- [x] unknown写入使用仅测试进程的I/O依赖注入与真实Exposer/ExecutionRuntime；生产MCP schema不新增注入参数。isError响应的structuredContent也显式用对应Zod schema校验，不能只依赖SDK调用未抛错。
- [x] 运行有针对性的所有新增测试，随后完整 `rtk npm run verify`，再独立 `rtk npm run test:benchmark`。确保进程PATH使用项目内置Node/npm，若环境需调整只修改本次进程。
- [x] 新验证文档逐条列E1—E8及原自查1—11的关闭/接受残余风险、测试名、实际命令和结果。重新生成受修复影响的40次基准数据，不复用旧时间。
- [x] 文档说明：A4除isError预算计量修正外未改变工具语义；响应字节下降不等于磁盘I/O或模型耗时下降；benchmark独立门禁有意不加入每次test:compiled。
- [x] 兼容性说明保留legacy重叠歧义拒绝，明确这是安全收紧；不恢复旧有不明确匹配行为。
- [x] 核对 `rtk proxy git diff --check`、工作区状态和提交列表；提交：`test: verify remediation with observed retries and MCP audit evidence`。

**M7 实施记录（2026-10-28）：** benchmark 增加 `TraceEvent`/`metricsFor`：从实际 MCP 调用记录 tool、target、expected/refreshed hash、observedCode；safe trace 观测到 1 次 conflict、0 次 unsafe retry，隔离 negative trace 故意复用旧 hash 得到 unsafeRetries=1，删除字面 true 和硬编码冲突数。真实 MCP `activity_recent` 已按 capability/inputSummary 验证单项搜索失败、错误+pending、正常截断；unknown 写入通过仅测试进程的文件 I/O hook、真实 `registerFsTools` handler 与 `ExecutionRuntime` 触发，structuredContent 被 `applyPatchManyOutputSchema` 显式校验，审计为 failed/ROLLBACK_UNCONFIRMED/never_automatic/human。新增 `docs/validation/MCP_FILE_CONTRACTS_REMEDIATION.md`，逐项记录 E1—E8、原自查 1—11、命令、实际计数和残余风险；原 A4 文档增加 remediation rerun 数据与“响应字节不等于磁盘 I/O/模型耗时”说明。完整 `npm run verify` 与独立 `npm run test:benchmark` 在 M7 实现后重新通过。

## 最终验收门槛

1. 有效V2请求的所有实际返回对象满足所选预算；全局默认64KiB/硬上限256KiB覆盖read/search/patch。
2. 可观察到的业务失败不被pending/裁剪掩盖，MCP与审计一致，策略拒绝不泄漏宿主路径。
3. committed时返回长度/hash与实际观察到的目标字节一致；短写/零进展不伪报成功；检测到外部变化时不静默覆盖。
4. 同一进程内的路径别名共用锁；不会因缺失祖先、异常或锁顺序产生并发绕过/死锁。
5. 无全文件行数组造成的无谓内存放大；batch读取在分配前受限。
6. 安全指标来自真实事件且负向校准能失败；完整verify与独立benchmark均有新证据。
7. 残余的跨进程/跨Runtime并发、hardlink/TOCTOU与非崩溃原子性如实记录；不把这些限制包装成已消除。

交付时报告：新提交范围、逐条关闭清单、验证结果、剩余风险。保持未推送/未合并/未部署状态，供独立复审。
