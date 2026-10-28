# MCP File Contracts Validation — A4 Protocol Benchmark

- 日期：2026-10-27
- 基线提交：`0a1ddf83c13ff0be77794adde80037689d92d391`
- 范围：A1 带版本范围读取、A2 同原文多编辑、A3 搜索覆盖/统一 outcome，以及 A4 协议基准
- 结论：四个固定场景在 legacy 与 V2 下均 5/5 完成；正常流程 `conflicts=0`、`unsafeRetries=0`；陈旧版本保护通过；A1 错误响应在加入 `isError` 后仍不超过所选 `max_bytes`。

## 1. 方法与边界

本验证使用仓库内置 Node `v22.23.1`，通过真实 stdio MCP 客户端驱动 `dist/index.js`，工作区固定为 `_p05_file_contracts_benchmark` fixture，profile 为 `full`，`MATLAB_MCP_ENABLED=false`，P05 状态目录也位于 fixture 内。

**没有模型参与。** `elapsedMs` 是本地 MCP 协议往返加本地 fixture 校验的时间，不是模型耗时、网络延迟或生产 SLA。`responseBytes` 是每次 MCP 工具调用结果对象（含 `content`、`structuredContent`、`isError`）的 JSON UTF-8 字节数之和，不是 JSON-RPC 信封，也不是 token 数。

每个场景、每个 variant 运行 5 次，共 40 次测量运行。测量前执行一次 `ping` 和一次 500 文件搜索作为 warm-up，不计入测量；这样减少首次冷缓存对搜索场景的影响。场景 fixture 在每次运行前重置，任务完成条件在驱动代码中独立验证。

## 2. 固定场景与任务完成条件

| 场景 | Legacy 驱动 | V2 驱动 | 完成条件 |
| --- | --- | --- | --- |
| 大文件定位 | 1 次 `fs_read_many({paths})` 读取 2000 行文件 | 1 次 V2 `fs_search` 定位 + 1 次 V2 范围读取 | 找到第 1700 行的 `TARGET_MARKER`，范围读取 hash 等于原始文件 hash |
| 同文件多处修改 | 1 次整文件读取 + 3 次顺序 `apply_patch` | 1 次 V2 范围读取 + 1 次 V2 `apply_patch_many`（3 个 edits） | 最终文件字节严格等于预期内容，V2 返回预期新 hash |
| 配置搜索 | 1 次 legacy `fs_search` 扫描 500 个文件 | 1 次 V2 `fs_search` 扫描同一目录 | 找到唯一 `TARGET_CONFIG_KEY` 文件；V2 coverage 为 complete/exhausted |
| 验证失败后的修复 | 读取 → 本地校验失败 → `apply_patch` → 再读取 | V2 读取 → 本地校验失败 → V2 单文件多编辑 → 再读取 | 初始校验失败，修复后文件字节等于预期内容且校验通过 |

“验证失败后的修复”中的校验是确定性的 fixture 校验（检查 `const target = 2;`），不是模型判断，也不是 `project_validate` 对 P05 平台的验证。

## 3. 实测结果

下表为每场景 5 次运行的汇总；`调用` 为 MCP 工具调用次数中位数，`响应字节` 为 5 次的中位数（本 fixture 中字节数稳定），`耗时` 为 5 次的中位数，括号内为最小–最大。全部场景 `successCount=5`。

| 场景 | Variant | 调用 | 响应字节 | 耗时中位数 (min–max, ms) |
| --- | --- | ---: | ---: | ---: |
| 大文件定位 | legacy | 1 | 104,273 | 7.863 (6.706–8.828) |
| 大文件定位 | V2 | 2 | 2,095 | 18.022 (17.002–24.186) |
| 同文件多处修改 | legacy | 4 | 1,097 | 33.322 (30.235–50.147) |
| 同文件多处修改 | V2 | 2 | 1,978 | 16.657 (14.829–24.358) |
| 配置搜索（500 文件） | legacy | 1 | 484 | 199.766 (196.217–225.776) |
| 配置搜索（500 文件） | V2 | 1 | 951 | 200.444 (190.729–208.815) |
| 验证失败后的修复 | legacy | 3 | 791 | 18.972 (17.904–20.256) |
| 验证失败后的修复 | V2 | 3 | 2,867 | 19.612 (18.457–32.639) |

观察（仅针对本 fixture 的协议测量）：

- **大文件定位**：V2 使用“搜索 + 单行范围读取”两次调用，响应从 104,273 字节降到 2,095 字节；本次本机测量中耗时中位数高于 legacy 整文件读取。调用次数不是越少越好，收益来自更小的正文传输。
- **同文件多处修改**：V2 从 4 次调用降为 2 次，耗时中位数下降；响应字节略高于 legacy，主要来自 V2 outcome、原始 hash 和结构化字段。修改正确性由最终文件字节验证。
- **配置搜索**：两者都是 1 次调用；V2 因 coverage/outcome 字段响应字节更高，耗时中位数接近。
- **验证失败后的修复**：两者都是 3 次调用；V2 结构化诊断字段更多，响应字节更高，耗时中位数接近。

这些是协议层字节与本地往返时间，不推导模型耗时、token 节省或生产环境提速比例。

## 4. A1 响应预算在 `isError` 之后仍成立

A1 的预算检查已把最终结果对象中的 `isError: true` 计入。benchmark 使用一个 stale `expected_sha256` 请求，`max_bytes=4096`，运行 5 次：

```json
{"check":"a1_error_budget","runs":5,"maxBytes":4096,"maxResponseBytes":939,"success":true}
```

5 次均为 MCP `isError=true`、outcome conflict，最大响应 939 字节，低于 4096 字节预算。相关回归同时位于：

- `src/test/file-contracts.ts`：A1 错误结果用包含 `isError` 的字节计量断言；
- `src/test/output-schema.ts`：真实 MCP 客户端 stale 错误结果 `serializedBytes(staleRead) <= 4096`。

## 5. 陈旧版本与零写入

benchmark 在计时运行外执行一次 stale guard：将 guard 文件从 `guard = stable` 外部改写为 `guard = external`，随后分别用旧 hash 调用 legacy `apply_patch` 和 V2 `apply_patch_many`。

```json
{"check":"stale_guard","legacyNoWrite":true,"v2NoWrite":true,"conflicts":2,"unsafeRetries":0}
```

- 两个接口都拒绝了陈旧版本。
- 外部内容 `guard = external` 被保留。
- 没有使用同一陈旧 hash 自动重试；`unsafeRetries=0`。
- 正常四个场景全部 `conflicts=0`、`unsafeRetries=0`。

## 6. 机器可读汇总

完整命令会为每次运行输出一条 JSON 行，并额外输出下列汇总行（本次实际输出）：

```json
{"summary":true,"scenario":"large_file_location","variant":"legacy","runs":5,"callsMedian":1,"callsMin":1,"callsMax":1,"responseBytesMedian":104273,"responseBytesMin":104273,"responseBytesMax":104273,"elapsedMsMedian":7.863,"elapsedMsMin":6.706,"elapsedMsMax":8.828,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"large_file_location","variant":"v2","runs":5,"callsMedian":2,"callsMin":2,"callsMax":2,"responseBytesMedian":2095,"responseBytesMin":2095,"responseBytesMax":2095,"elapsedMsMedian":18.022,"elapsedMsMin":17.002,"elapsedMsMax":24.186,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"same_file_multi_edit","variant":"legacy","runs":5,"callsMedian":4,"callsMin":4,"callsMax":4,"responseBytesMedian":1097,"responseBytesMin":1097,"responseBytesMax":1097,"elapsedMsMedian":33.322,"elapsedMsMin":30.235,"elapsedMsMax":50.147,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"same_file_multi_edit","variant":"v2","runs":5,"callsMedian":2,"callsMin":2,"callsMax":2,"responseBytesMedian":1978,"responseBytesMin":1978,"responseBytesMax":1978,"elapsedMsMedian":16.657,"elapsedMsMin":14.829,"elapsedMsMax":24.358,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"config_search_500_files","variant":"legacy","runs":5,"callsMedian":1,"callsMin":1,"callsMax":1,"responseBytesMedian":484,"responseBytesMin":484,"responseBytesMax":484,"elapsedMsMedian":199.766,"elapsedMsMin":196.217,"elapsedMsMax":225.776,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"config_search_500_files","variant":"v2","runs":5,"callsMedian":1,"callsMin":1,"callsMax":1,"responseBytesMedian":951,"responseBytesMin":951,"responseBytesMax":951,"elapsedMsMedian":200.444,"elapsedMsMin":190.729,"elapsedMsMax":208.815,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"validation_failure_repair","variant":"legacy","runs":5,"callsMedian":3,"callsMin":3,"callsMax":3,"responseBytesMedian":791,"responseBytesMin":791,"responseBytesMax":791,"elapsedMsMedian":18.972,"elapsedMsMin":17.904,"elapsedMsMax":20.256,"successCount":5,"conflicts":0,"unsafeRetries":0}
{"summary":true,"scenario":"validation_failure_repair","variant":"v2","runs":5,"callsMedian":3,"callsMin":3,"callsMax":3,"responseBytesMedian":2867,"responseBytesMin":2867,"responseBytesMax":2867,"elapsedMsMedian":19.612,"elapsedMsMin":18.457,"elapsedMsMax":32.639,"successCount":5,"conflicts":0,"unsafeRetries":0}
```

benchmark 最终标记：`FILE_CONTRACTS_BENCHMARK_OK (67 checks, 40 runs)`。

## 7. 复现命令

在 `D:\Project_Git\P05_V2_Deployment` 执行：

```powershell
rtk npm run test:benchmark
```

该脚本会先构建，再运行 `dist/test/file-contracts-benchmark.js`。等价的显式命令：

```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts-benchmark.js
```

完整回归：

```powershell
rtk npm run verify
rtk proxy git diff --check
```

注意：`test:benchmark` 不在 `test:compiled` 内，因为它是证据采集而非每次提交都必须运行的正确性门禁；完整性门禁仍是 `npm run verify`。

## 8. 已知边界

- 本基准没有模型/服务端模型参与；不能据此推断 token 节省、模型耗时或生产网络性能。
- `responseBytes` 统计 MCP 工具结果对象，不含 JSON-RPC 信封；不同客户端或协议版本可能增加少量信封开销。
- 计时包含本地 stdio 往返、审计落盘和 fixture 校验；绝对值受本机文件系统、Windows Defender 和 warm-up 影响。表中同时给出 min–max。
- “验证失败后的修复”使用本地确定性 fixture 校验，不代表 `project_validate`、业务工程验证器或 CI 的行为。
- 除 A1 `isError` 预算计量修正外，A4 未改变工具语义、Runtime 生命周期或阶段 B 的默认禁用状态；本验证未重启 Runtime、未推送、未合并。

## 2026-10-27 remediation rerun (M7)

The A4 table above is the pre-remediation record. After M1—M6, the benchmark was regenerated from actual MCP calls (40 runs, 5 per scenario/variant):

| Scenario | Variant | Calls | Response bytes | Median ms |
| --- | --- | ---: | ---: | ---: |
| Large-file location | legacy | 1 | 104,273 | 7.149 |
| Large-file location | V2 | 2 | 2,342 | 19.620 |
| Same-file multi-edit | legacy | 4 | 1,097 | 36.479 |
| Same-file multi-edit | V2 | 2 | 2,064 | 39.770 |
| 500-file config search | legacy | 1 | 484 | 404.965 |
| 500-file config search | V2 | 1 | 1,176 | 487.695 |
| Validation failure repair | legacy | 3 | 791 | 33.306 |
| Validation failure repair | V2 | 3 | 2,953 | 24.871 |

- Final marker: `FILE_CONTRACTS_BENCHMARK_OK (66 checks, 40 runs)`.
- Observed retry trace: `{"safeConflicts":1,"safeUnsafeRetries":0,"negativeUnsafeRetries":1}`. The negative trace deliberately reuses the already rejected hash and is counted; the safe trace does not.
- A4 changed only the `isError` budget accounting in addition to documentation/tests; response bytes are not disk-I/O, model-latency or token measurements.
- `test:benchmark` remains a separate evidence command, intentionally not part of every `test:compiled`.
