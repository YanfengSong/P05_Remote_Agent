# A1—A4 独立审查与本地自查复核

日期：2026-10-27
项目：`D:\Project_Git\P05_V2_Deployment`
分支：`codex/v2-agent-workflow-pilot`
审查基点：`f16af7cf7443ffa9cae6d4770406371cb95a3b42`
审查终点：`7d491b9e433ee903a7b83ece0be55612d0cd6791`

## 结论

**暂不合并或部署。** A1—A4 的正常路径已实现，但独立检查确认了写入成功误报、可检测的并发追加丢失、读取错误被截断状态掩盖，以及预算没有落实到全部 V2 工具等问题。

本报告不是重述测试计数：审查直接阅读固定提交的源代码，并在独立临时 fixture 中运行故障探针。未修改功能代码、未重启 Runtime、未推送或合并，也没有重跑并据此宣称完整 verify 通过。用户交付的 1,533 检查和 40 次基准属于原实现的历史验证记录。

本次使用 code-review 的 Standards/Spec 双轴检查；下文保留两轴结论，随后给出独立实证及原自查逐项处理。执行方案另见 [修复计划](../superpowers/plans/2026-10-27-mcp-file-contracts-remediation.md)。

## Standards

1. **[P2，可复现] 缺失多级父目录时，同一目标可能使用两把锁。**
   `src/tools/file-write-lock.ts:19-27` 只尝试解析目标和直接父目录；两者不存在时退回词法路径。`src/tools/files.ts:69-73` 随后允许递归创建目录。内部 junction 的 alias/new/nested/file.txt 与 real/new/nested/file.txt 因而取得不同锁。违反设计 A2 的“P05 自身同路径写入共用互斥锁”。源代码探针显示：父目录缺失时两 key 不相等，创建父目录后相等。应逐级寻找最近存在且可解析的祖先，再拼回缺失段；区分不存在与访问失败。这是进程内锁缺陷，不是无法消除的外部 TOCTOU。

2. **[P2，维护性判断] 重复文件 I/O 实现已出现安全语义分叉。**
   `read-ranges.ts:116-155` 有界读取并复核 size；`files.ts:269-285` 缺少后检；`files.ts:373-380` 使用 stat 后的无限 readFile。提交与回滚在 `files.ts:593、645` 忽略 bytesWritten。属于 Duplicated Code 的具体风险，应抽取小型有界快照与完整写入原语，避免重构整个工具层。短写和无限预检模式在基点已存在，不能误称全部由 A2 引入；但新契约依赖它们，仍须修复。

3. **[P3，改进] dry_run 可随共享临界区改进一致性。**
   `files.ts:989-1009` 在锁外预检，dry_run 直接返回。expected hash 仍被验证，不能据此断言任意错误版本会成功预览或发生数据损坏。主要问题是与 P05 自身 truncate/write 重叠时产生瞬态拒绝；建议在锁内生成预览，作为配套改进。

Standards：2 项需修复/整理，1 项非阻断改进；最严重的新增规范问题是锁键分裂。

## Spec

1. **全局响应预算缺失。** R03 要求“默认正文预算 64 KiB，硬上限 256 KiB……整个 MCP 结果”。`src/tools/register-fs.ts:189、337` 的 V2 search/patch 直接返回结果。实测搜索 382,616 字节，超过硬上限；20 文件 dry_run 为 260,617 字节，超过默认预算。补丁只能裁剪预览，必须保留全部写入效果记录，不能因输出预算隐藏已执行操作。

2. **读取聚合把实际失败当正常截断。** A3 要求“结构化 conflict/rejected/error/unknown 不能产生 succeeded”。`src/tools/read-ranges.ts:296` 优先处理 pendingIndexes，覆盖已有失败。其后又把单项 PATH_REFUSED、ACCESS_DENIED、READ_LIMIT_INVALID 等降为 READ_FAILED/safe，与固定错误表及权限错误恢复要求不一致。应先保留失败语义，再表达未返回范围；多项失败使用保守恢复建议。

3. **V2 搜索根错误泄漏路径并缺少结构化结果。** `src/tools/files.ts:1083` 直接 lstat，输入相对 missing-root，异常包含完整宿主临时根路径。违反现有文件层错误脱敏约定。旧版也存在该模式，新增 V2 继续暴露；应捕获映射，不能删掉授权检查来获得统一结果。

4. **A4 安全指标未实际测量。** 计划要求记录冲突及误重试。`src/test/file-contracts-benchmark.ts:125` 的 unsafeRetries 从不增加；`:565` 断言字面 true；`:570` 硬编码冲突数。应增加能失败的冲突→刷新→重试场景和事件累计，或移除未覆盖指标及结论。

Spec：4 组确认问题；最严重的是实际失败被聚合为正常截断。

## 独立实证

| ID | 证据及结果 | 判断 | 修复任务 |
| --- | --- | --- | --- |
| E1 | 首项返回 35 行且仍有后续行，第二请求进入 pending；最终 **4098 >4096 字节** | 最终结果未重新计量，R03 违约 | M1 |
| E2 | missing.txt 读取失败，第二个大单行请求 pending；failureCount=1，outcome=READ_TRUNCATED，isError=false | 实际错误被正常截断掩盖；审计分类随之错误 | M1、M7 |
| E3 | 注入成功返回的短写；返回 committed、25 字节，实际仅12字节，返回 hash 与实际不符 | **P1：成功误报/数据完整性风险** | M2 |
| E4 | 在最终 handle.read 返回前追加外部文本；结果 committed，追加内容消失 | **P1：可检测的增长被快照遗漏，后续覆盖** | M2 |
| E5 | V2 搜索 100 文件×每文件5条中文命中，真实 handler 输出382,616字节 | 超256KiB硬上限 | M4 |
| E6 | V2 dry_run 20文件，含 JSON 控制转义的预览；输出260,617字节 | 超默认64KiB；此例未超256KiB硬上限 | M4 |
| E7 | 内部 junction + 两级缺失父目录，两目标实际同文件但 key 不同；目录存在后相同 | 进程内写锁遗漏 | M3 |
| E8 | V2 search 根为相对 missing-root，原始异常带完整解析后路径 | 错误脱敏缺口 | M5 |

E1—E4、E7 的诊断脚本：[read-write-probes.mjs](review-2026-10-27/read-write-probes.mjs)。
E5、E6、E8 的诊断脚本：[handler-probes.mjs](review-2026-10-27/handler-probes.mjs)。
汇总记录：[evidence.json](review-2026-10-27/evidence.json)。

复现命令（项目根运行）：
```powershell
rtk proxy .p05/tools/node/node.exe node_modules/tsx/dist/cli.mjs docs/validation/review-2026-10-27/read-write-probes.mjs
rtk proxy .p05/tools/node/node.exe node_modules/tsx/dist/cli.mjs docs/validation/review-2026-10-27/handler-probes.mjs
```

这些是**诊断脚本**，打印观测值，不作为修复后的通过门禁。短写/读取期间增长通过进程内 fs 包装注入，仅针对自建临时文件，不修改真实工程文件。handler 探针直接调用注册后的 handler，并非再次完成真实 stdio 端到端验证；修复计划要求将关键案例补到真实 MCP 测试。脚本通过 tsx 导入 src，避免 dist 版本不明。

### E1 的边界说明

复现要求先前已经加入的文件项在表达上仍有未读范围，或同类使信封增长的组合。对“整文件恰好完整”的部分样本，READ_COMPLETE→READ_TRUNCATED 会缩短文案，未必溢出。因此不能将“有 pending 必溢出”当作结论。缺陷在于最终结果没有可靠的统一预算检查；独立 fixture 与原自查的 4112 字节使用不同内容，数值不必相同。

### E4 的保证边界

增加读取后 stat/EOF 检查能发现本次注入的追加；内容、时间戳和身份复核还能发现更多变化。但任何“检查→truncate/write/unlink”仍可能与非合作外部进程竞争。**本次不承诺用更多 stat/hash 获得 OS 级 CAS。** 方案要求诚实记录可观察到的变化和 unknown，并在文档中保留跨进程残余风险。

## 对本地自查 11 项的逐项处置

| 原编号 | 独立结论 | 处置 |
| --- | --- | --- |
| 1 最终 pending 预算 | 确认，独立复现4098/4096；实际终点文件最终return在572行 | M1，同时修复错误被pending掩盖 |
| 2 短写 | 确认，实际12/预期25仍committed；是既有底层缺陷 | M2，提交和回滚共用完整写入与验证 |
| 3 外部追加/窗口 | 确认其中“读取期间增长未检测”；其余检查后窗口是残余限制 | M2修可检测缺口，不宣称消除所有竞争 |
| 4 预检无限读取 | 静态确认stat后readFile；不是A2独创 | M2，读取前/分配前限制，不在读完后才限制 |
| 5 V2路径错误无outcome | 确认；搜索根还会泄漏原始绝对路径 | M5；保留政策检查并捕获映射，SDK schema拒绝仍可走协议错误 |
| 6 dry_run没锁 | 降级为P3一致性/可用性改进，hash保护仍存在 | M3顺带在锁内预检，不当作独立数据损坏 |
| 7 物化全文件行数组 | 静态确认，未通过制造OOM验证 | M6改为线性扫描/迭代，内存不随行对象数量放大 |
| 8 unsafeRetries恒零 | 确认；正常场景指标不能证明安全重试 | M7真实轨迹计数与负向校准 |
| 9 分支/端到端覆盖 | 覆盖缺口成立；确定性故障hook本身不是假通过 | M5/M7增加stat/readdir/链接/oversized及真实MCP→audit验证 |
| 10 文档与基准口径 | “A4未改变工具行为”需澄清；响应字节不等于磁盘I/O | M7修文档；benchmark独立于verify是已明确的设计，不算缺陷 |
| 11 legacy重叠歧义收紧 | 确认是安全性行为变化 | 保留拒绝，写兼容说明和回归，不恢复歧义成功 |

## 新增补充

- **实际失败+pending 的成功误报**，以及单失败策略码被 READ_FAILED/safe 覆盖，应作为同一聚合器修复，不能仅在末尾加一次字节检查。
- **搜索和补丁未落实全局 R03**；不应为通过检查而把已批准的全局要求悄悄缩成“只限读取”。
- **缺失父目录的锁键分裂**不同于跨进程竞争，可在现有进程内模型中修复。
- 对“真实 fs 错误”的测试，固定的故障注入是合法方法；需要证明失败分支被执行，而不是为了凑真实ACL测试修改用户主机权限。
- 不要将错误结果通过 SDK 的调用成功误当作 outputSchema 已验证：部分 SDK 对 isError 响应不执行相同的成功输出验证。测试须显式验证预期结构。

## 实施范围和退出条件

只修改阶段 A 的文件契约、共享 I/O、错误映射及对应测试/文档。维持当前分支，保留已有 A1—A4 提交；不启动阶段 B、不改真实 .env、不增OS沙箱或跨Runtime锁工程、不自动合并或重启。

M1—M7 完成后提供新提交范围、每条问题的关闭证据、完整 verify 与独立 benchmark 的实际结果，再由审查方复核。运行中 Runtime 尚未切换到这些代码；新验证成功也不等于已部署。
