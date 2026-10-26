# MCP File Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本环境执行时使用已安装的 `executing-plans` 技能，按任务顺序在当前会话执行；未获用户授权不派生子 Agent。此文档只规划，复选框代表尚未实施的工作。

**Goal:** 让远端以更少调用获得可用于安全补丁的文件版本，并可靠区分截断、冲突和未知写入效果。

**Architecture:** 在现有注册工具上加入显式 V2 分支，复用当前路径策略与写入底层。将范围读取、编辑计算和结果预算拆为小模块；旧请求保持原契约。

**Tech Stack:** Node v22.23.1、TypeScript、Zod v4、MCP SDK v2、node:assert/strict；不增加生产依赖。

**Spec:** [V2_AGENT_WORKFLOW_PILOT.md](../../architecture/V2_AGENT_WORKFLOW_PILOT.md)，重点 R01—R04。

## Global Constraints

- 唯一实施目录：`D:\Project_Git\P05_V2_Deployment`；基线 `9defb33fd24774e4cfd28389b9bb7918f77ca945`。
- 旧工具名和旧请求的成功响应保持兼容。新语义显式使用 `contract_version: 2`。
- 路径、workspace、profile、审批和审计沿用现有控制点。
- 默认正文预算 64 KiB，硬上限 256 KiB（新契约序列化后的整个 MCP 结果 UTF-8 字节，含重复正文和信封）。
- 文件版本使用原始字节 SHA-256；不承诺跨文件事务或通用文件系统 CAS。
- 所有 shell 命令以 `rtk` 开头；文中命令在唯一实施目录运行。
- 本阶段不启动 Codex、不改变运行中 Runtime、不发布或合并代码。

## 文件分工与验证方法

| 文件 | 职责 |
| --- | --- |
| 新建 `src/tools/file-contracts.ts` | 新请求/响应类型、Outcome 和输入限制 |
| 新建 `src/tools/read-ranges.ts` | 有界文件缓冲区、行切分、范围读取、原始字节版本 |
| 新建 `src/tools/patch-edits.ts` | 对同一原文定位唯一替换、重叠检查、候选计算 |
| 新建 `src/tools/file-write-lock.ts` | P05 所有文件写入口共享的规范路径锁 |
| 新建 `src/tools/result-budget.ts` | 计算整个 MCP 结果大小并产生可前进的截断结果 |
| 修改 `src/tools/files.ts`、`register-fs.ts`、`result.ts` | 复用策略和写入执行、接入新分支 |
| 修改 `src/capability/registry.ts`、`src/runtime/execution.ts` | 工具描述和失败审计映射 |
| 新建 `src/test/file-contracts.ts`、`src/test/file-contracts-benchmark.ts` | 回归、故障和固定 fixture 字节基准 |
| 修改 `src/test/output-schema.ts`、`profile-exposure.ts`、`package.json` | MCP schema/profile 回归、编入现有测试 |
| 新建 `docs/validation/MCP_FILE_CONTRACTS.md` | 实测结果与复现条件 |

统一编译命令（先跑失败用例，最小实现后再跑同一命令）：

```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts.js
```

集成进 `test:compiled` 的片段为 `node dist/test/file-contracts.js`。每任务新增具体测试函数，使用仓库已有的顶层自执行测试风格与 `node:assert/strict`；临时文件均在独立 fixture 根，测试显式设置 allowed roots，不借用真实业务文件。

## A1. 范围读取、版本与响应预算

**Files:** 新建 file-contracts.ts、read-ranges.ts、result-budget.ts、src/test/file-contracts.ts；修改 register-fs.ts、registry.ts、package.json、output-schema.ts。

**Interfaces:**
```ts
export type ReadRequest = {
  path: string; offset: number; limit: number; expected_sha256?: string;
};
export type ReadSlice = {
  path: string; sha256: string; totalLines: number;
  offset: number; returnedLines: number; text: string;
  complete: boolean; nextOffset?: number;
};
export function splitLines(text: string): string[];
export function readRange(root: string, request: ReadRequest): Promise<ReadSlice>;
export function serializedBytes(value: unknown): number;
```
Outcome 使用规格第 6 节的完整定义；单文件失败映射成带 code 的结果项，不把一个文件失败变成整批未读。

- [x] 新增实际断言：CRLF、空文件、尾换行、BOM、中文、非法 UTF-8、二进制、8 MiB 上限；两次分页间修改文件时 expected_sha256 冲突。
```ts
import assert from "node:assert/strict";
import { splitLines } from "../tools/read-ranges.js";
import { serializedBytes } from "../tools/result-budget.js";
assert.deepEqual(splitLines("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
assert.deepEqual(splitLines(""), []);
assert.deepEqual(splitLines("a\n"), ["a\n"]);
assert.equal(serializedBytes({ text: "中" }), Buffer.byteLength('{"text":"中"}'));
```
- [x] 运行统一编译/测试命令，确认新模块缺失或对应断言失败；记录失败原因，不能把环境错误当预期红灯。
- [x] 实现最小纯函数与读取层；原始 buffer 先 hash，再严格解码；读取的 descriptor 与结果来自同一数据源；沿用实际路径授权检查。
```ts
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
```
- [x] 接入顶层 object Zod schema：paths 和 requests 互斥；requests 必须带 contract_version:2。新结果返回未完成范围、pendingIndexes 和每文件错误；旧 paths 路径原样执行。预算器对最终 content+structuredContent 测量，回退整行直到满足预算；不能无限返回相同 nextOffset。
- [x] 跑读取/预算测试和 output-schema：默认正文在 text 客户端可见；两个中文转义/大单行/20 个长路径案例均不超 max_bytes；超过上限的 metadata 返回固定有界错误。
- [x] 提交：`rtk git commit -m "feat: add versioned range reads with bounded MCP results"`，只暂存本任务列出的文件。

**A1 实施记录（2026-10-26）：**
- 新增 `src/tools/file-contracts.ts`、`src/tools/read-ranges.ts`、`src/tools/result-budget.ts`；`fs_read_many` 的 legacy `paths` 分支保持原输出，V2 分支由 `contract_version: 2` 显式选择。
- 单文件读取上限为 `min(config.maxReadBytes, 8 MiB)`；非正整数配置失败关闭。hash、行数、正文来自同一份受限 buffer；BOM 不进入展示但进入 hash，CRLF 原样保留。
- 预算统计最终 `{content, structuredContent}` 的 JSON UTF-8 字节。超预算时按整行裁剪并返回 `nextOffset`；未处理请求返回 `pendingIndexes`；单行无法容纳时返回 `LINE_TOO_LARGE`；连错误信封都放不下时返回固定 `RESULT_BUDGET_TOO_SMALL`。
- V2 错误使用固定 code/message，不包含解析后的宿主绝对路径。读取沿用 `assertAccessiblePath`，现有 hardlink/TOCTOU 局限未改变。
- `src/test/file-contracts.ts` 覆盖 154 项检查；`output-schema.ts` 增加真实 stdio MCP 客户端预算、正文可见性、续读、协议边界和 legacy 回归检查；`profile-exposure.ts` 验证 readonly profile 下 V2 范围读取仍只读可用。未引入 `isError`，执行审计的失败分类统一仍留给 A3。
- 读取 hash 通过测试与既有 `patchTextFile` 衔接：BOM 与 CRLF fixture 在 UTF-8 解码/重编码后仍保持原始字节 hash。

## A2. 同原文多编辑与诚实的写入结果

**Files:** 新建 patch-edits.ts、file-write-lock.ts；修改 files.ts、register-fs.ts、file-contracts.ts、src/test/file-contracts.ts。

**Interfaces:**
```ts
export type TextEdit = { old_text: string; new_text: string };
export function applyEditsToText(original: string, edits: TextEdit[]): string;
export function withWriteLocks<T>(
  canonicalPaths: readonly string[], action: () => Promise<T>
): Promise<T>;
```
新补丁请求对每个文件保存 expected_sha256 + edits；旧 old_text/new_text 分支转换为单编辑后保持原响应。锁按规范化路径排序获取，逆序释放，不能对同一锁二次获取造成死锁。

- [ ] 新增失败测试，证明编辑都基于原文、重叠/歧义拒绝。还要覆盖批次第二个目标过期时第一个目标零写入、dry_run 零写入、大小写别名重复。
```ts
import { applyEditsToText } from "../tools/patch-edits.js";
assert.equal(applyEditsToText("a b", [
  { old_text: "a", new_text: "b" },
  { old_text: "b", new_text: "c" }
]), "b c");
assert.throws(() => applyEditsToText("abc", [
  { old_text: "ab", new_text: "x" },
  { old_text: "bc", new_text: "y" }
]), /overlap/);
assert.throws(() => applyEditsToText("x x", [
  { old_text: "x", new_text: "y" }
]), /ambiguous/);
```
- [ ] 跑统一命令观察失败；分别注入发布失败、回滚失败、回滚前外部改写，预期结果区分 rolled_back 与 unknown。
- [ ] 实现定位和候选计算；唯一出现可用 indexOf + 第二次 indexOf（从首个位置+1）检查；排序后要求前项 end <= 后项 start，再倒序替换。空 old_text 拒绝，不自动模糊匹配。
```ts
const spans = edits.map(edit => {
  const start = original.indexOf(edit.old_text);
  if (!edit.old_text || start < 0) throw new Error("missing");
  if (original.indexOf(edit.old_text, start + 1) >= 0) throw new Error("ambiguous");
  return { start, end: start + edit.old_text.length, text: edit.new_text };
}).sort((a, b) => a.start - b.start);
for (let i = 1; i < spans.length; i++) {
  if (spans[i - 1].end > spans[i].start) throw new Error("overlap");
}
let result = original;
for (const span of spans.reverse()) {
  result = result.slice(0, span.start) + span.text + result.slice(span.end);
}
```
- [ ] 接入共享写锁，覆盖 fs_write、fs_write_many、apply_patch 和 apply_patch_many；复用既有路径策略、总大小预检与发布逻辑。回滚只恢复仍与本次写出 hash 相符的目标，否则保留现场并返回 never_automatic。旧错误响应可增加诊断，但不吞掉 MCP isError。
- [ ] 跑完整 file-contracts 与现有 foundation 测试；验证三处替换只需一个原始 hash，失败没有静默覆盖外部文件。
- [ ] 提交：`rtk git commit -m "feat: apply multiple edits against one reviewed file revision"`。

## A3. 搜索覆盖范围与执行审计

**Files:** 修改 files.ts、register-fs.ts、file-contracts.ts、result.ts、src/runtime/execution.ts、src/test/file-contracts.ts、src/test/output-schema.ts、src/test/profile-exposure.ts。

**Interfaces:**
```ts
export type SearchCoverage = {
  complete: boolean;
  stopReason: "exhausted" | "result_limit" | "file_limit" | "byte_limit" | "io_error";
  scannedFiles: number;
  skippedByReason: Record<string, number>;
};
export function outcomeFor(code: string): Outcome;
```
Outcome 从 file-contracts.ts 导入。complete 表示声明的可搜索范围已遍历完，不表示受保护路径也被读取；排除项始终计数。

- [ ] 新增有限 fixture：命中不足、命中过多、不可读文件、二进制/生成目录；验证没有命中且 io_error 时 complete=false。新增审计断言：结构化 conflict/rejected/error/unknown 不能产生 succeeded。
```ts
import { outcomeFor } from "../tools/file-contracts.js";
assert.equal(outcomeFor("STALE_REVISION").status, "conflict");
assert.equal(outcomeFor("STALE_REVISION").effectState, "none");
assert.equal(outcomeFor("ROLLBACK_UNCONFIRMED").retry, "never_automatic");
assert.equal(outcomeFor("READ_TRUNCATED").status, "partial");
```
- [ ] 跑统一命令，确认新字段和审计断言失败。
- [ ] 实现固定错误码映射，未知写入错误默认 unknown/never_automatic；读取普通 I/O error 使用 error/none/safe，权限错误 rejected/none/never_automatic。V2 搜索返回 coverage 和有界 nextAction，旧请求保留原输出。
```ts
const stale: Outcome = {
  status: "conflict", effectState: "none", retry: "after_refresh",
  code: "STALE_REVISION", nextAction: "Read the current file and rebuild the patch."
};
```
- [ ] 在执行结果分类处解释新契约，不改变所有旧工具的成功判断；读取 partial 记录成功但带截断元信息，写入 unknown 记录失败且恢复建议不包含自动重试。
- [ ] 跑 file-contracts、output-schema、profile-exposure；确认 readonly 仍无写权限、新字段不泄漏绝对宿主路径。
- [ ] 提交：`rtk git commit -m "feat: report search coverage and actionable tool outcomes"`。

## A4. 集成与效率证据

**Files:** 新建 src/test/file-contracts-benchmark.ts、docs/validation/MCP_FILE_CONTRACTS.md；修改 package.json、src/test/file-contracts.ts、PROJECT_STATUS.md。

**Interfaces:** benchmark 输出 JSON 行：
`{scenario, variant, calls, responseBytes, elapsedMs, success, conflicts, unsafeRetries}`。
variant 为 legacy 或 v2；不将 responseBytes 当模型 token 数。

- [ ] 在测试中固定四套 fixture：2000 行文件定位、同文件三处唯一替换、500 文件配置搜索、一次验证失败后修复。断言最终文件字节正确、陈旧版本不写入、unsafeRetries=0。
```ts
const expected = Buffer.from("const count = 2;\nreturn count + 1;\n", "utf8");
assert.deepEqual(actualFileBytes, expected);
assert.equal(measurement.unsafeRetries, 0);
assert.ok(measurement.responseBytes <= measurement.calls * 262144);
```
actualFileBytes 从修复 fixture 的结果文件读取；measurement 是该场景驱动按上述 JSON 行结构累计的实际结果，不硬编码假测量值。
- [ ] 对未接入的 V2 路径运行基准，确认失败能定位缺少的行为；完成 MCP 客户端驱动后执行：
```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts-benchmark.js
```
- [ ] 将四个 fixture 的调用驱动固定到 legacy/v2 两条路径，使用 performance.now 与实际序列化结果计数，写入验证文档；每场景至少 5 次。没有模型服务则明确记录“仅协议基准”，不写模型效率结论。
- [ ] 执行 `rtk npm run verify`；若环境继承导致 PowerShell 模块或 allowed roots 故障，按项目验证脚本配置本进程环境后重跑失败项，并在报告中区分分项通过与完整 verify 通过。
- [ ] 记录全部实际命令、失败修复与测量；不运行真实业务工具作为测试；确认 `rtk git diff --check` 通过。
- [ ] 提交：`rtk git commit -m "test: benchmark and verify MCP file contracts"`。

## 完成门槛

R01—R04 全部可追踪到 A1—A4 的测试；旧客户端与现有检查通过；所有新 V2 响应有界；错误效果不明确时不会自动重试。满足后阶段 A 可以单独发布，阶段 B 仍默认禁用。
