# Local Agent Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本环境执行时使用已安装的 `executing-plans` 技能，在当前会话按任务顺序执行；未获用户授权不派生子 Agent。真实 Provider 的启用条件见 B6；完成 fake provider 不代表真实试点通过。

**Goal:** 提供可查询、可恢复、能审查具体证据版本的单任务本地 Codex 委派。

**Architecture:** AgentTaskService 复用 V2 的 workspace、权限与审计入口，使用独立 TaskRepository 保存状态。Supervisor 管理独立 Git 副本、Provider 进程和验证证据；只通过受限 MCP 返回结果。

**Tech Stack:** Node v22.23.1、TypeScript、Zod v4、node:sqlite 适配层、Windows Job Object、Codex CLI 0.147.0（本机查验版本）、node:assert/strict。

**Spec:** [V2_AGENT_WORKFLOW_PILOT.md](../../architecture/V2_AGENT_WORKFLOW_PILOT.md)，重点 R05—R12；[ADR-0022](../../adr/ADR-0022-v2-agent-workflow-pilot.md)。

## Global Constraints

- 唯一实施目录：`D:\Project_Git\P05_V2_Deployment`；实施分支从 V2 基线创建。
- 路径、workspace、profile、审批和审计沿用现有控制点。
- 默认正文预算 64 KiB，硬上限 256 KiB（新契约序列化后的整个 MCP 结果 UTF-8 字节，含重复正文和信封）。
- 阶段 B 默认禁用；本地单独启用并配置 Provider、验证器及预算。trusted approval 开关不会自动启用委派。首版每 slot 最大在途任务数为 1。
- 提交幂等、先持久化后启动；UNKNOWN 不自动重新执行。
- 审批只授权该次调度，不授权后续重试、合并或推送。HTTP reviewer 的新增任务工具仅查询。
- 执行使用独立 Git 副本及本地固定启动器，shell:false、windowsHide:true；prompt 经 stdin。
- 工作副本仅是写入和 Git 元数据隔离。Codex sandbox 不等同于 P05 工具逐项许可或整机读取隔离。
- 证据由 P05 采集并绑定候选内容摘要和验证器配置摘要；自述测试结果单独标识。
- 先 fake provider 故障测试，再一次性样例仓库真实试点。
- 所有 shell 命令以 `rtk` 开头；Windows 路径操作采用 LiteralPath 和规范化根校验。

## 文件地图和公共测试入口

| 文件 | 责任 |
| --- | --- |
| 新建 src/agent/contracts.ts、lifecycle.ts | 任务、上下文、Provider、状态机契约 |
| 新建 src/agent/task-repository.ts、sqlite-task-repository.ts | 持久化接口与每 slot SQLite 实现 |
| 新建 src/agent/task-service.ts、dispatch-reservation.ts | 幂等提交、授权对账与调度 |
| 新建 src/agent/workspace-copy.ts、supervisor.ts、providers/codex-cli.ts | 副本、进程生命周期、JSONL 适配 |
| 新建 src/agent/evidence.ts、validation.ts、redaction.ts | 内容版本、监督验证、脱敏输出 |
| 新建 src/agent/config.ts、providers/registry.ts | 本地启用配置和 Provider 注册 |
| 新建 src/tools/register-agent.ts | 五个任务工具的 schema/Exposer 适配 |
| 修改 src/workspace/manager.ts、src/policy/permission-broker.ts、expose.ts | context revision、调度授权协议 |
| 修改 src/index.ts、src/http/reviewer.ts、src/tools/register-control.ts、register-review-context.ts、src/capability/registry.ts | 初始化与表面暴露 |
| 新建 scripts/agent/run-job.ps1、probe-job.ps1 | Windows Job Object 启动器与探针 |
| 新建 src/test/agent-pilot.ts、agent-store.ts、agent-process.ts、agent-evidence.ts | 分类测试 |
| 新建 src/test/fixtures/fake-agent.ts | 可控进程：日志、挂起、退出、子孙进程、异常事件 |
| 新建 docs/validation/LOCAL_AGENT_PILOT.md | 门槛、实测版本、故障记录和试点结果 |
| 修改 package.json、PROJECT_STATUS.md | 测试入口和状态 |

编译和核心回归：
```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/agent-pilot.js
rtk proxy .p05/tools/node/node.exe dist/test/agent-store.js
rtk proxy .p05/tools/node/node.exe dist/test/agent-evidence.js
```
Windows 进程检查独立运行：`rtk proxy .p05/tools/node/node.exe dist/test/agent-process.js`。不满足 Job Object 条件时测试报告真实失败，不能 skip 后算真实 Provider 已通过。普通 CI 可以只完成 fake 核心测试，并明确真实 Provider 尚不可启用。

## B1. 状态与 Provider 契约

**Files:** 新建 contracts.ts、lifecycle.ts、providers/registry.ts、src/test/agent-pilot.ts、src/test/fixtures/fake-agent.ts。

**Interfaces（类型导出自 contracts.ts；transition 导出自 lifecycle.ts）:**
```ts
export type RunState = "QUEUED" | "DISPATCHING" | "RUNNING" |
  "CANCELLING" | "EXECUTED" | "FAILED" | "CANCELLED" | "UNKNOWN";
export type ReviewState = "PENDING" | "ACCEPTED" | "CHANGES_REQUESTED";
export type ExecutionContext = Readonly<{
  contextId: string; bindingRevision: number; runtimeSlot: string;
  authorityScope: string; workspaceId: string; baseCommit: string;
  providerConfigDigest: string; validationConfigDigest: string;
  timeoutMs: number; maxOutputBytes: number;
}>;
export type TaskRequest = Readonly<{
  task: string; idempotencyKey: string; expectedContextId: string;
  baseCommit: string; validationProfileId: string; parentRunId?: string;
}>;
export type ProviderEvent =
  | { type: "output"; stream: "stdout" | "stderr"; bytes: Uint8Array }
  | { type: "exit"; code: number | null; signal: string | null };
export type ProviderLaunch = Readonly<{
  runId: string; cwd: string; prompt: string; context: ExecutionContext;
}>;
export interface ProviderHandle {
  events: AsyncIterable<ProviderEvent>;
  cancel(): Promise<"terminated" | "unknown">;
}
export interface AgentProvider {
  readonly id: string;
  start(input: ProviderLaunch): Promise<ProviderHandle>;
}
export function transition(state: RunState, next: RunState): RunState;
```
ProviderLaunch 只由 P05 内部构造，MCP 不接受 cwd。exit 事件只是进程事实，不能直接将 review 改 ACCEPTED。

- [ ] 写状态测试，覆盖合法边及拒绝的跳转；fake provider 由明确模式产生 events，保存启动计数供后续幂等测试使用。
```ts
import assert from "node:assert/strict";
import { transition } from "../agent/lifecycle.js";
assert.equal(transition("QUEUED", "DISPATCHING"), "DISPATCHING");
assert.equal(transition("RUNNING", "EXECUTED"), "EXECUTED");
assert.throws(() => transition("UNKNOWN", "RUNNING"), /invalid_transition/);
assert.throws(() => transition("EXECUTED", "RUNNING"), /invalid_transition/);
assert.throws(() => transition("RUNNING", "CANCELLED"), /invalid_transition/);
```
- [ ] 编译并运行 agent-pilot，确认尚未存在的状态检查导致失败。
- [ ] 用显式边集合实现 transition；QUEUED 可到 DISPATCHING/CANCELLED/FAILED/UNKNOWN，DISPATCHING 可到 RUNNING/CANCELLING/FAILED/UNKNOWN，RUNNING 可到 CANCELLING/EXECUTED/FAILED/UNKNOWN，CANCELLING 可到 CANCELLED/FAILED/UNKNOWN，终态不允许重新运行。
```ts
const allowed = edges[state];
if (!allowed.includes(next)) throw new Error("invalid_transition");
return next;
```
edges 为上述规则的 `Record<RunState, readonly RunState[]>`，每个状态都有键。
- [ ] 测试 fake provider 的退出不触发审查、取消未确认返回 unknown、未知 JSON 事件不能伪造执行成功。
- [ ] 提交：`rtk git commit -m "feat: define bounded agent task lifecycle and provider contracts"`。

## B2. 持久化、上下文版本和单任务所有权

**Files:** 新建 task-repository.ts、sqlite-task-repository.ts、config.ts、src/test/agent-store.ts；修改 workspace/manager.ts、register-control.ts、register-review-context.ts、src/test/agent-pilot.ts。

**Interfaces:**
```ts
export type Reservation = { runId: string; reservationId: string; created: boolean };
export type TaskRecord = {
  runId: string; reservationId: string; requestDigest: string;
  context: ExecutionContext; state: RunState; version: number;
  authorizationState: "pending" | "bound" | "unknown";
};
export interface TaskRepository {
  reserve(request: TaskRequest, context: ExecutionContext): Promise<Reservation>;
  get(runId: string): Promise<TaskRecord | null>;
  setState(runId: string, expectedVersion: number, state: RunState): Promise<TaskRecord>;
  bindAuthorization(reservationId: string, approvalId: string): Promise<void>;
  appendEvent(runId: string, type: string, payload: unknown): Promise<number>;
  close(): Promise<void>;
}
```
ExecutionContext、TaskRequest、RunState 从 contracts.ts 导入。SqliteTaskRepository 构造参数为本地 `{dbPath:string,runtimeSlot:string,ownerId:string}`。ownerId 是启动随机标识，结合 OS 单实例/进程锁判定 owner；不要靠可过期 lease 在进程存活不明时自动抢占。

- [ ] 在独立临时 DB 写唯一键/摘要测试：相同请求返回同 run，不同请求同 key 报 idempotency_conflict；并发两个不同 key 只有一个获在途 slot；重开 DB 后状态/事件序号不丢失。
```ts
const first = await repository.reserve(request, context);
const again = await repository.reserve(request, context);
assert.equal(first.runId, again.runId);
assert.equal(again.created, false);
await assert.rejects(
  repository.reserve({ ...request, task: request.task + " changed" }, context),
  /idempotency_conflict/
);
```
测试中的 request/context 构造自 contracts.ts，使用临时 workspaceId=fake-workspace、authorityScope=fake-authority、实际 fixture commit，不使用真实账号或路径。
- [ ] 编译并运行 agent-store，先观察数据库实现缺失/唯一约束失败。
- [ ] 实现版本化 DDL 和事务：tasks 唯一键含 slot/authority/workspace/key；requestDigest 用排序键规范 JSON 的 SHA-256；events 唯一(runId,seq)。存储 WAL/FULL/busy_timeout；磁盘满或事务失败时不返回可调度 reservation。
```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, PRIMARY KEY(run_id, seq)
);
```
tasks 的全部字段对应 TaskRecord、请求唯一键及创建时间；用受控 SQL 参数绑定，禁止拼接远端输入。
- [ ] workspace registry 增加持久化 binding revision；A→B→A、同 id root 重新绑定均递增；旧状态首次迁移生成 revision，不能每次启动回到 0。contextId 是绑定描述摘要，不包含可读绝对路径。
- [ ] 跑双实例 owner、崩溃恢复、只读 reviewer 不调度、损坏 DB、写入失败用例；重启时无法确认的 DISPATCHING/RUNNING/CANCELLING 进入 UNKNOWN，仍占住调度门槛直到本地完成进程对账。
- [ ] 提交：`rtk git commit -m "feat: persist agent reservations and workspace context revisions"`。

## B3. 权限绑定、幂等工具和崩溃窗口

**Files:** 新建 task-service.ts、dispatch-reservation.ts、tools/register-agent.ts；修改 policy/permission-broker.ts、expose.ts、capability/registry.ts、index.ts、http/reviewer.ts、src/test/agent-pilot.ts、src/test/profile-exposure.ts、src/test/http-reviewer.ts。

**Interfaces:**
```ts
export type DispatchAuthorization = {
  reservationId: string; approvalId: string; requestDigest: string;
  contextId: string; status: "bound" | "unknown";
};
export interface AgentTaskService {
  submit(request: TaskRequest): Promise<{ runId: string; state: RunState }>;
  status(runId: string): Promise<TaskRecord>;
  cancel(runId: string): Promise<{ state: RunState }>;
}
```
工具层先做当前权限检查；service 从可信 host context 取工作区/slot/authority，本身不相信请求中的身份。agent_result/agent_review schema 在本任务注册，具体证据访问接 B5；未有证据时返回 evidence_not_ready，不能直接 accept。

- [ ] 用 fake provider 验证同 key 连续/并发提交只启动一次，客户端断线重提返回相同 run。对审批前、reservation 后、消费审批后、spawn 前后注入进程重启；恢复只对账，无法证明未执行时 UNKNOWN。
```ts
const a = await service.submit(request);
const b = await service.submit(request);
assert.equal(a.runId, b.runId);
assert.equal(fakeProvider.startCount, 1);
```
fakeProvider.startCount 为 B1 fake provider 的计数，service 使用测试 TaskRepository 和现有 Broker 的临时状态目录。
- [ ] 运行 agent-pilot/profile-exposure/http-reviewer，确认新注册点未接入时失败。
- [ ] 实现 submit 顺序：检查访问权/context/config/基线→查询或创建 reservation→审批绑定 reservation→持久化 bound→DISPATCHING→调用 Provider。同键已有任务只返回原任务；对相同绑定中断可继续审批核对，不能产生第二次 dispatch。
```ts
if (!reservation.created) return existingAuthorizedTask;
if (authorization.status !== "bound") throw new Error("dispatch_authorization_unknown");
// Only the durable owner may transition this reservation to DISPATCHING.
```
existingAuthorizedTask 由 repository.get 和当前权限检查构造，不把客户端传入 runId 当授权。
- [ ] 对 PermissionBroker 的批准/执行记录增加 reservationId，并明确一次性消费的 crash 对账规则；保持旧工具流程不变。Exposer 对 submit 返回记录“调度已接受”，审计链接 runId，不记录“任务已完成”。
- [ ] 注册五个 capability；HTTP reviewer 无条件只注册 agent_status/agent_result；readonly 无 submit/cancel/review；开 trusted 模式但 provider disabled 仍拒绝提交。拒绝跨 slot/workspace/context 查询和过期 context 提交。
- [ ] 跑现有 policy/exposure/HTTP reviewer 测试和 agent-pilot；通过后提交：`rtk git commit -m "feat: bind agent submissions to existing authorization and idempotency"`。

## B4. 独立副本和可终止的 Codex 执行器

**Files:** 新建 workspace-copy.ts、supervisor.ts、providers/codex-cli.ts、scripts/agent/run-job.ps1、probe-job.ps1、src/test/agent-process.ts；修改 config.ts、providers/registry.ts、src/test/fixtures/fake-agent.ts。

**Interfaces:**
```ts
export type CopyResult = { cwd: string; baseCommit: string; manifestDigest: string };
export function prepareCopy(
  sourceRoot: string, destination: string, baseCommit: string
): Promise<CopyResult>;
export function buildCodexArgs(cwd: string): readonly string[];
```
CodexCliProvider 实现 B1 AgentProvider；可执行文件与固定前缀由 config.ts 本地配置传入，不能出现在远端 submit schema。prepareCopy 仅接 host 决定的路径。

- [ ] 写测试：dirty/错 commit/越界路径/受保护 tracked 文件拒绝；源仓库在运行后 tracked/untracked/HEAD/refs 均未改变；副本 .git 不是共享 gitdir，remotes 为空。恶意 prompt 中的引号、反引号、换行不改变 argv。
```ts
assert.deepEqual(buildCodexArgs("D:\\fixture space\\run"), [
  "--ignore-user-config", "exec", "--json",
  "--sandbox", "workspace-write", "--cd", "D:\\fixture space\\run", "-"
]);
```
必须先用目标版本 help 和受控 fixture 验证该参数组合；版本升级后重新做兼容检查，不能只测试数组。
- [ ] 实现前先跑 Windows 探针：父进程、子进程、孙进程分别持续写 marker；取消/owner 退出后均停止，且不会误杀同 PID 不同启动身份的进程。测试失败则记录真实 Provider 不可用。
- [ ] 实现独立 clone：固定 git executable，禁用 hooks、交互提示与外部 filter；clone --no-local --no-hardlinks --no-checkout，以批准 commit checkout，删除副本 remote 配置；checkout 前对该 tree 受保护路径和 Git attributes/filter 行为预检。源与目标规范化验证后执行，拒绝相同目录或目标为源的祖先；源为平台工程时，嵌套目标只能是已被 Git 忽略且受保护的 .p05 任务子目录。
- [ ] 实现 PowerShell/C# Job Object helper：创建 kill-on-close job，先挂起创建子进程，附加 Job 成功后恢复；配置不可 breakaway；匿名管道转发 stdin/stdout/stderr，命令行参数按 Windows API 规则编码。任何 attach 失败终止尚未恢复的子进程并返回 unavailable。
```ts
const childOptions = { shell: false, windowsHide: true, cwd: copy.cwd };
// Prompt travels through stdin; never concatenate it into command text.
```
此选项用于 Node 启动固定 helper；helper 的 CreateProcess 参数同样只来自本地 launcher 配置与参数数组。
- [ ] 实现 JSONL 有界解析与输出计数、15 分钟/16 MiB 预算、取消确认。应用本地选择的 sandbox 与配置隔离；无法确认整棵进程树退出时 UNKNOWN，不能释放 slot 启动下一个任务。
- [ ] 跑 agent-process 的超时、超输出、坏 JSON、启动失败、重启/孤儿进程和取消竞态；真实 Codex 只在 B6 一次性 fixture 启用。
- [ ] 提交：`rtk git commit -m "feat: supervise isolated Codex task processes on Windows"`。

## B5. 验证证据、分页访问和审查版本

**Files:** 新建 evidence.ts、validation.ts、redaction.ts、src/test/agent-evidence.ts；修改 task-repository.ts、sqlite-task-repository.ts、task-service.ts、register-agent.ts。

**Interfaces:**
```ts
export type CandidateEntry = {
  path: string; mode: string; state: "added" | "modified" | "deleted";
  sha256: string | null;
};
export type ValidationRecord = {
  profileId: string; configDigest: string; candidateDigest: string;
  startedAt: string; finishedAt: string; exitCode: number | null;
  logRef: string; source: "observed";
};
export type EvidenceManifest = {
  runId: string; baseCommit: string; candidateDigest: string;
  entries: CandidateEntry[]; validations: ValidationRecord[];
  evidenceDigest: string; stale: boolean;
};
export function digestCandidate(entries: readonly CandidateEntry[]): string;
export function redactText(text: string, secretValues: readonly string[]): string;
```
TaskRepository 扩展 `saveEvidence(manifest: EvidenceManifest): Promise<void>`、`getEvidence(runId:string): Promise<EvidenceManifest|null>`、`review(runId:string,digest:string,decision:"accept"|"request_changes",note:string):Promise<ReviewState>`。source=selfReported 的 Provider 消息单独存事件，不能转换为 ValidationRecord。

- [ ] 新增证据测试：顺序不同摘要相同、内容/路径/删除状态变动摘要不同；执行后修改候选导致 stale；失败/缺失的必要验证不能 accept；resultRef 跨权限域拒绝。
```ts
const entries = [
  { path: "a.ts", mode: "100644", state: "modified" as const, sha256: "a".repeat(64) },
  { path: "b.ts", mode: "100644", state: "deleted" as const, sha256: null }
];
assert.equal(digestCandidate(entries), digestCandidate([...entries].reverse()));
assert.notEqual(digestCandidate(entries), digestCandidate(entries.slice(0, 1)));
assert.equal(redactText("token=fixture-secret", ["fixture-secret"]), "token=[REDACTED]");
```
- [ ] 跑 agent-evidence，确认未实现的摘要/审查检查失败；注入令牌分成两个 chunk、中文/路径、二进制、超长日志进行泄漏断言。
- [ ] 实现规范序列化摘要，排序键与路径，保持模式和删除项；candidate 包含新文件。仓库外部 symlink/reparse point 拒绝读取。验证器固定 executable/argv、运行在副本、沿用 Job/预算管理；开始前和结束后采集候选。
```ts
const canonical = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  .map(({ path, mode, state, sha256 }) => ({ path, mode, state, sha256 }));
const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
```
createHash 从 node:crypto 导入。验证修改了候选时标记该记录不适用于最终 candidateDigest；重新运行验证必须有界，首版可直接返回需人工处理，不能自动无限循环。
- [ ] 实现脱敏后日志分页、不可猜测 resultRef、单页 R03 限制；DB 只存索引/摘要。到 20 个终结任务或单任务 32 MiB 配额时拒绝新增，不自动删除。
- [ ] agent_review 比较当前候选与最新 evidenceDigest，再通过 DB 版本 CAS 保存审查决定；仅对静止任务和满足验证策略的证据允许 accept；结果不触发 merge/commit/push。
- [ ] 跑 agent-evidence、agent-pilot、HTTP reviewer 和 output-schema；通过后提交：`rtk git commit -m "feat: bind agent review to supervised versioned evidence"`。

## B6. 集成、故障验收和真实样例门槛

**Files:** 修改上述测试、package.json、PROJECT_STATUS.md；新建 docs/validation/LOCAL_AGENT_PILOT.md。

**Deliverable:** 一份清楚区分 fake 测试、Windows 进程检查和真实 Codex 样例的验收报告；默认配置仍 disabled，具体试点以本地显式配置开启。

- [ ] 将 agent-pilot/agent-store/agent-evidence 加入 test:compiled；agent-process 作为 Windows 专项入口。新增真实样例入口 `src/test/agent-codex-pilot.ts`，默认要求 `P05_AGENT_PILOT_LIVE=1` 且目标是测试新建 fixture，不能接受任意业务目录。
- [ ] 先跑故障矩阵：审批窗口崩溃、重复提交、同 slot 双 owner、workspace A→B→A、启动前/后断线、磁盘满、坏 JSON、任务/日志预算、进程树取消、旧证据审查、结果串权限域。验证没有二次执行与静默权限扩张。
- [ ] 编译并运行核心回归、agent-process 和现有 `rtk npm run verify`；记录实际环境与失败项。没有 Windows 能力或本地 Codex 身份时保留明确未通过项，不能写“全部完成”。
- [ ] 在真实样例前检查本地 config：明确可信主机模式、绝对 launcher、固定 sandbox、有效本地登录、环境 allowlist、验证器 profile、任务/输出预算。该步骤读取可用性和版本，不打印凭据；如果启用需要用户未提供的本地选择，先完成其余门槛再说明缺项。
- [ ] 新建无凭据小型 Git fixture：sum.ts 的 add(a,b) 错误返回 a-b；固定 Node 验证器断言 add(2,3)===5。任务只要求修复 add 并运行指定验证。真实入口记录前后 SHA、所有事件、监督验证和 evidenceDigest，执行一次 submit→status→result→review。
```ts
import assert from "node:assert/strict";
assert.equal(add(2, 3), 5);
assert.equal(add(-2, 3), 1);
```
add 是 fixture 被测导出；验收检查 observed 验证 exitCode=0、源 fixture 未变、副本仅有批准的变更、审查绑定正确摘要。另用 fake provider 覆盖取消，避免为测试浪费真实推理调用。
- [ ] 记录时间、调用数、输出字节与实际 Provider usage（缺失则写 unavailable），与阶段 A 的直接工具路径比较。通过前不推广到业务工程，不自动合并候选。
- [ ] `rtk git diff --check` 通过，提交：`rtk git commit -m "test: validate local agent pilot and recovery boundaries"`。

## 交付判断

- B1—B3：可用 fake provider 验证受控调度与恢复，不代表真实执行器可用。
- B4—B5：进程与证据门槛通过，仍需要一次性真实样例。
- B6：真实样例通过后，才可讨论选定业务工程的试点；阶段 B 保持可选。
- 实施过程中发现无法保证审批对账、进程终止或证据访问边界，应提交问题与复现材料并保持真实 Provider 禁用；不通过缩小测试范围宣称验收成功。
