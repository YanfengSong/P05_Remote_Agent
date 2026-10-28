# MCP File Contracts Remediation Evidence

Date: 2026-10-27
Functional baseline: `7d491b9e433ee903a7b83ece0be55612d0cd6791`
Remediation commits: M1 `1bef0b9`, M2 `05052c4`, M3 `2951b8b`, M4 `31d3aeb`, M5 `9084c67`, M6 `2ba72b1`; M7 below.

## E1—E8 closure

| ID | Closure | Evidence |
| --- | --- | --- |
| E1 final budget | Closed by M1 | `M1 E1` uses a 36-line file, 35-line first request and a long failing second request; final MCP bytes <= 4096, pending `[1]`. |
| E2 failure masked | Closed by M1 | `M1 E2`: `failureCount=1`, outcome `NOT_FOUND`, pending `[1]`, `isError=true`; failure no longer becomes `READ_TRUNCATED`. |
| E3 short write | Closed by M2 | `writeAllAtStart` loops; deterministic short-write test commits expected bytes/hash; zero progress and interrupted writes are not committed. |
| E4 external append | Closed by M2 | `readBoundedSnapshot` detects growth; append during final read yields `unknown`, external bytes preserved. |
| E5 search budget | Closed by M4 | Real MCP 100×5 Chinese search at 4096/65536/262144; every client result <= budget, `responseTruncated` and returned counts explicit. |
| E6 patch budget | Closed by M4 | Real MCP 20-file JSON-control dry_run; 65536/262144 keep all 20 statuses, 4096 returns `RESULT_BUDGET_TOO_SMALL` with no writes; previews marked truncated. |
| E7 lock key split | Closed by M3 | alias/real missing-ancestor keys equal; barrier max concurrency 1; lock released after action failure. |
| E8 root path leak | Closed by M5 | V2 missing root returns `not_started`/`NOT_FOUND`, never includes fixture root; other root and hardlink errors structured and redacted. |

## Original self-check closure

| # | Status | Evidence |
| --- | --- | --- |
| 1 final pending budget | Closed | M1 finalizer and `M1 E1`; all exits measured with duplicate body + `isError`. |
| 2 short write | Closed | M2 `writeAllAtStart`; file-io 19 checks and batch short-write test. |
| 3 external append/window | Partially closed | Read-time growth detected and preserved; check-to-write and same-size races remain residual (no OS CAS). |
| 4 preflight unbounded read | Closed | M2 bounded snapshots in batch preflight, commit/rollback, created cleanup and legacy `readTextFile`. |
| 5 V2 path errors | Closed | M5 structured V2 patch/search failures; hardlink, protected, outside and root errors redacted. |
| 6 dry_run lock | Closed | M3 `withBatchLocks` holds the shared lock through dry-run preflight; barrier test. |
| 7 full-file line array | Closed | M6 `selectLineWindow`/`iterateLines`; dense newline stress under 64 MiB heap. |
| 8 unsafeRetries | Closed | M7 actual trace `metricsFor`; safe trace 0, deliberate stale retry 1. |
| 9 branch/end-to-end | Closed | M5 real junction/oversized and injected readdir/stat/read; M7 real handler + ExecutionRuntime unknown write and MCP `activity_recent`. |
| 10 docs/fairness | Closed | This file and updated A4 validation doc; A4 semantics exception and response-vs-I/O caveat documented. |
| 11 legacy ambiguity | Accepted tightening | Overlapping `old_text` remains rejected; documented as safety behavior. |

## Verification

Commands run from `D:\Project_Git\P05_V2_Deployment` with project-local Node v22.23.1:

```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts.js
rtk proxy .p05/tools/node/node.exe dist/test/file-io.js
rtk proxy .p05/tools/node/node.exe dist/test/output-schema.js
rtk npm run verify
rtk npm run test:benchmark
rtk proxy git diff --check
```

Observed results:

- `FILE_CONTRACTS_OK (482 checks)`
- `FILE_IO_OK (19 checks)`
- `OUTPUT_SCHEMA_OK (312 checks)`
- `PROFILE_EXPOSURE_OK (266 checks)`, `FOUNDATION_OK (58 checks)`
- Full verify: policy 335, profile 266, HTTP 80, foundation 58, file-contracts 482, file-io 19, git 27, operator 93, output 312, plugin 35, plugin API 4, sync 11; downstream smoke passed.
- Benchmark: `FILE_CONTRACTS_BENCHMARK_OK (66 checks, 40 runs)`.
- Retry trace: `{"safeConflicts":1,"safeUnsafeRetries":0,"negativeUnsafeRetries":1}`.

## Residual risks

- Locks are in-process only; external processes and separate Runtime slots are not serialized.
- Hardlink and TOCTOU path-policy limits remain; a checked link can be replaced before open/write.
- A same-size in-place read can still be torn; bounded snapshots detect size/metadata changes, not all content races.
- Legal rollback windows after the final hash check remain; no OS-level CAS or crash atomicity is claimed.
- Legacy per-file read errors without V2 outcome still audit as succeeded; V2 structured outcomes are the A3 contract.
- A4 benchmark is protocol-only; response-byte reductions are not claims about disk I/O, model latency or tokens.
