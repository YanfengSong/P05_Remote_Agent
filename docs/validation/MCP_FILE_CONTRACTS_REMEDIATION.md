# MCP File Contracts Remediation Evidence

Date: 2026-10-28
Functional baseline: `7d491b9e433ee903a7b83ece0be55612d0cd6791`
Remediation commits: M1 `1bef0b9`, M2 `05052c4`, M3 `2951b8b`, M4 `31d3aeb`, M5 `9084c67`, M6 `2ba72b1`, M7 `b4192c2`.
Closure-review commits: F1 `91a9954`, F2 `47e7ebf`, F3 `780bc86`, F4 `3047511`, F5 `bf5d8fa`, F6 `f114432`.

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

## 2026-10-28 closure review F1—F5

| Fix | Commit | Closed behavior |
| --- | --- | --- |
| F1 effect envelope | `91a9954` | Patch error prose is bounded by final JSON UTF-8 bytes, not character count. The pre-mutation skeleton uses the real renderer and models every target as a failed file, so it is an upper bound for committed, rolled-back and unknown outcomes. After execution, optional previews/error prose may be shortened, but target status, hashes and effect state are never dropped or replaced by a budget exception. |
| F2 rollback identity | `47e7ebf` | Rollback compares the visible path's `lstat` dev/ino with the opened handle before touching it, and again after restoration. Missing, replaced, symlinked or non-regular paths become `unknown`; the moved inode is not rewritten through the old handle. New-file cleanup also requires identity match before deletion, so identical content on a replacement inode is preserved. |
| F3 search truncation | `780bc86` | Response trimming preserves `matchesTruncated` from the scan layer (`original || trimmed`). `coverage` continues to describe the scan, `responseTruncated` describes the response, and response-only trimming points to `max_bytes` while scan limits point to `max_results`; both are mentioned when both apply. Real I/O errors keep priority. |
| F4 bounded search diagnostics | `3047511` | V2 `not_started` errors omit unbounded `query`/`root` and set `metadataOmitted`; the schema marks those fields optional. The finalizer removes request metadata before trimming matches, so a 5000-character path, long Unicode path, 500-character query or successful long-root search returns a schema-valid bounded result instead of throwing from the finalizer. |
| F5 target-scoped retries | `bf5d8fa` | `retry-metrics.ts` keys stale hashes by canonical target + expected hash, invalidates reads that predate a conflict, and treats a read after the conflict as informed only when it returns the same hash. Per-file `errorCode` attributes multi-target conflicts; missing diagnostics produce a separate call-level count instead of copying the top-level conflict to every target. Unit of account: `callId` links events from one MCP call; `conflicts`/`unsafeRetries` count target events, while a conflict with no target diagnostics is reported separately as `unattributedConflicts`. |
| F6 created side effect | `f114432` | The batch commit path registers an opened handle immediately after `fs.open`, before the first identity `stat`. A `wx+` success followed by an identity-query failure therefore keeps the target in the unified resource/effect path: the handle is closed by the common finally, the target is classified `unknown`, and the file is preserved because identity cannot justify deletion. Error text states that a file may have been created and must be inspected. An existing file whose first identity query fails remains a no-write `none` failure with unchanged bytes. A test-only Node preload injects the `stat` failure for the real stdio MCP regression; production schemas/handlers expose no fault-injection parameter. |

Regression highlights:

- F1: `F1 4096` rejects before mutation with zero writes; `F1 7168` returns a full `rolled_back` envelope with long Chinese paths; `F1 8192` returns `unknown` with the replacement preserved; `F1 committed` fits 4096; emoji/quote/backslash/control-character error prose fits 6144.
- F2: rename+replace, rename-to-missing, same-content replacement, normal rollback, in-place external rewrite, and new-file replacement cleanup; the real handler/`ExecutionRuntime` audit remains `failed`, `ROLLBACK_UNCONFIRMED`, `never_automatic`, `recoveryHint=human`.
- F3: upstream 6-match file keeps `matchesTruncated=true` after response trimming at 65536 and 262144; scan-only, response-only, both, and I/O-failure cases are asserted; real MCP budget calls verify the marker and `max_bytes` guidance.
- F4: real MCP 5000-ASCII path and combined 500-character query + 1500-character Unicode path return `isError=true`, `not_started`, `metadataOmitted=true`, ≤4096 bytes and no host path; schema parses the `isError` structuredContent.
- F5: safe trace 1 conflict/0 unsafe, negative trace unsafe=1, real MCP multi-target trace 1 attributed conflict/0 unsafe/0 unattributed; A/B same hash, repeated stale hash, refreshed hash, re-read same hash and alias canonicalization are covered.
- F6: single and persistent identity-query `EIO`, replacement during the failed query, existing-file query failure, multi-target mixed creation, normal create/rollback and F2 rename+replace; a real stdio MCP `fs_write_many` call is `isError=true`, reports possible creation and leaves the empty target for inspection while closing the handle.

## Verification

Commands run from `D:\Project_Git\P05_V2_Deployment`; each `cmd.exe /c` sets the project-local Node directory first on `PATH`, `REMOTE_AGENT_ALLOWED_ROOTS` and `REMOTE_AGENT_DEFAULT_CWD` to the repository, and `MATLAB_MCP_ENABLED=false`:

```powershell
rtk proxy .p05/tools/node/node.exe node_modules/typescript/bin/tsc -p tsconfig.json
rtk proxy .p05/tools/node/node.exe dist/test/file-contracts.js
rtk proxy .p05/tools/node/node.exe dist/test/file-io.js
rtk proxy .p05/tools/node/node.exe dist/test/output-schema.js
cmd.exe /c "... .p05\tools\node\npm.cmd run verify"
cmd.exe /c "... .p05\tools\node\npm.cmd run test:benchmark"
rtk proxy git diff --check
```

Observed results:

- `FILE_CONTRACTS_OK (604 checks)`
- `FILE_IO_OK (19 checks)`
- `OUTPUT_SCHEMA_OK (328 checks)`
- `PROFILE_EXPOSURE_OK (266 checks)`, `FOUNDATION_OK (58 checks)`
- Full verify: policy 335, profile 266, HTTP 80, foundation 58, file-contracts 604, file-io 19, git 27, operator 93, output 328, plugin 35, plugin API 4, sync 11; downstream smoke passed; total 1,860 checks.
- Benchmark: `FILE_CONTRACTS_BENCHMARK_OK (69 checks, 40 runs)` from the F5 run; F6 does not touch the benchmark scenarios or assertions, so it was not rerun mechanically.
- Retry trace: `{"safeConflicts":1,"safeUnsafeRetries":0,"negativeUnsafeRetries":1,"multiConflicts":1,"multiUnsafeRetries":0,"multiUnattributed":0}`.
- A1 error budget: maximum 939 bytes under `max_bytes=4096`, including `isError`.

## Residual risks

- Locks are in-process only; external processes and separate Runtime slots are not serialized.
- Hardlink and TOCTOU path-policy limits remain; a checked link can be replaced before open/write.
- A same-size in-place read can still be torn; bounded snapshots detect size/metadata changes, not all content races.
- Legal rollback windows after the final hash check remain; no OS-level CAS or crash atomicity is claimed.
- Legacy per-file read errors without V2 outcome still audit as succeeded; V2 structured outcomes are the A3 contract.
- F1 may shorten or omit optional error prose to fit `max_bytes`; target status, hashes and effect state remain authoritative. The preflight skeleton is conservative, so some low budgets reject before mutation even when a more compact successful result might have fit.
- F2 still has a race window after the final path-identity check; a replacement between that check and a later operation is not eliminated without OS-level CAS.
- F4 omits `query`/`root` from V2 responses when the budget requires it and marks `metadataOmitted`; omitted metadata must not be treated as an exact path. Legacy error text stays redacted but legacy success output remains unchanged.
- F5 metrics are only as good as trace attribution: a call-level conflict without per-target diagnostics is counted separately and never guessed into an unsafe retry.
- F6 intentionally leaves a possibly empty created file when identity cannot be confirmed; it reports `unknown` and requires inspection rather than deleting by path or empty content. No automatic retry or cleanup is added.
- A4 benchmark is protocol-only; response-byte reductions are not claims about disk I/O, model latency or tokens.
