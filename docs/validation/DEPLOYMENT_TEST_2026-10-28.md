# P05 Deployment Acceptance — 2026-10-28

## Scope and version matrix

- Branch: `codex/v2-agent-workflow-pilot`
- Branch pushed to `origin/codex/v2-agent-workflow-pilot`; not merged.

| Stage | Code commit | Evidence/docs | Verification |
| --- | --- | --- | --- |
| F1—F6 reviewed baseline | `5ef4e88` | `5ef4e88` | 604 file-contract + 328 output; 1,860 total |
| Large-file streaming + configurable search | `d945f0b` | `d55b172` | intermediate build; superseded below |
| Oversized-search message | `da7c8e0` | `bcc1c28` | intermediate build |
| Read-limit triage + current deployment | `691c493` | `de558c8` | 644 file-contract + 328 output; 1,900 total |
| Current evidence consolidation | this commit | this document | benchmark 69 checks/40 runs |

- The current deployed code is `691c493`; `de558c8` records the evidence at that code revision.
- The independent review coverage ends at `5ef4e88` (F6). The large-file streaming and
  configurable-search code was implemented and tested after that review, but has not received
  the same independent code-review depth.
- Full `npm run verify` at the current code: 1,900 checks. Benchmark: 69 checks/40 runs.
- No merge and no stage-B work.

## Production baseline (before replacement)

| Slot | PID | Started | Agent | Profile | Workspace |
| --- | ---: | --- | --- | --- | --- |
| A | 32328 | 2026-10-27 20:59 | 0.3.1 | full | `p02_vmodel` |
| B | 31620 | 2026-10-27 20:59 | 0.3.1 | full | `p04_vehicle_dynamic` |

- Both were launched through `scripts/deployment/launch-runtime.mjs A|B` and the
  `p05-a`/`p05-b` tunnel profiles.
- Their process start predates commit `7d491b9` (2026-10-27 21:11), so the in-memory
  revision predates M1—M7 and F1—F6. The exact old revision was not stamped.
- Configuration snapshot: `P05_RUNTIME_SLOTS=A,B`, Operator port `56301`, MATLAB enabled,
  Runtime profiles `p05-a`/`p05-b`, allowed root/default cwd `P05_V2_Deployment`.
- Backups: `.p05/backups/deployment-20261028/` (`env.bak`, Runtime A/B state, rollback
  commands). `dist/index.js` before replacement:
  SHA-256 `94450D503A60DF035A64C03C0DF78A5B5E1ED5C82E58BA2D0364EAA587CE5082`.

## Isolated acceptance instance

- Endpoint: `http://127.0.0.1:8766/mcp` (Streamable HTTP MCP).
- State: `.p05/deployment-test-state`; workspace: `.p05/deployment-test-workspace`
  (moved there after the run); profile `developer`; approval `trusted`.
- Test-only Node preload was not used for the normal acceptance flow; it is only used by the
  F6 fault regression in `output-schema`.
- Production tunnels, workspaces, `.env`, approval mode and state were not used by this
  instance.

## Acceptance result

The client performed 19 MCP calls and 65 assertions covering:

1. `fs_search` V2 (search) and legacy search.
2. `fs_read_many` V2 range read and legacy read, plus legacy `fs_read`.
3. `apply_patch_many` V2 multi-edit dry run and commit.
4. Disk hash/content check after commit.
5. Old-hash conflict (`STALE_REVISION`, no write).
6. Read and search response truncation at `max_bytes=4096`.
7. Path refusal and protected-path refusal, without host-root leakage.
8. Legacy `fs_write_many` and legacy `apply_patch_many`.
9. `activity_recent` audit events and `recovery_status`.

Observed:

- Result: **65 checks passed**, `ok=true`.
- **19 MCP calls**, **102,450 response bytes**, **8,580 ms** end-to-end (second run).
  First run: 19 calls, 71,801 bytes, 8,878 ms. Audit/recovery output grows with the retained
  audit window, so its byte share is not stable; the core tool flow (excluding
  device/audit/recovery) was **24,560 bytes / 6,386 ms / 16 calls**.
- V2 search: 1,704 bytes; V2 range read: 1,350 bytes; multi-edit dry run: 1,326 bytes;
  commit: 995 bytes. Legacy search/read/write/patch remained usable.
- Truncated read: 4,062 bytes (≤4096); truncated search: 3,620 bytes (≤4096).
- Audit contained successful search/read/patch and the stale conflict; no host root leaked.

Usability conclusion: the V2 path combines dry-run, reviewed-revision multi-edit, explicit
truncation/outcome and audit in fewer calls than the legacy per-file workflow. The measured
response bytes are protocol payloads, not disk I/O or model/token savings.

## Production replacement

- Runtime A restarted as PID **10140** at 2026-10-28 17:27:57; Runtime B as PID **37936** at
  2026-10-28 17:28:00.
- Both tunnel `/readyz` checks returned `200 ready`.
- `dist/index.js` was rebuilt from the reviewed large-file/search-capacity build; the
  production `.env` now sets the range/search limits above.
- Existing tunnel profiles, `.env`, workspace bindings, profiles and approval mode were not
  changed. Agent version remains `0.3.1`.
- The local operator bridge is created when an MCP session initializes; no ChatGPT connector
  session was initiated from this environment. The user-side connector should perform one
  read-only smoke (`device_info` / `fs_search` / `fs_read_many`) to confirm the connector path.

## ChatGPT connector verification (user-run)

The following was executed by the user through the actual ChatGPT connector, not by the local
Streamable HTTP acceptance client. It confirms the connector/tunnel path in addition to the
local protocol test.

- Both slots: `agentVersion=0.3.1`, online; A `p02_vmodel` (`P02_Vmodel`), B
  `p04_vehicle_dynamic` (`P04_Vehicle_Dynamic`).
- Root searches with the 1 GiB budget: A scanned 3,759 files / 590,566,721 bytes; B scanned
  3,466 files / 824,745,209 bytes; both `coverage.complete=true`,
  `stopReason=exhausted`, `outcome.code=SEARCH_COMPLETE`, zero matches.
- Large-file range reads:
  - A: 2,688,221-byte file, 91,518 lines, first 20 lines, SHA-256
    `ef76106b6db5277ba7a9f870c3bd0cea88629da0a8fbb2864504a9486f1c363b`; lines 21–25 read
    successfully.
  - B: 8,524,456-byte file, 399,002 lines, first 20 lines, SHA-256
    `b4fc9c4e77f876bb57678ad14d11f36b8bfa60434567bec60fc00bc7edac90f2`; lines 21–25 read
    successfully.
  - Both hashes matched independent PowerShell `Get-FileHash`; `max_bytes=65536`;
    no `READ_TOO_LARGE`; `READ_TRUNCATED` reflects the requested partial page.
- A 3.64 MB single-line JSON returned `LINE_TOO_LARGE`; this is the expected single-line
  boundary, distinct from `READ_TOO_LARGE` and normal `READ_TRUNCATED`.
- Stale-hash submission returned `STALE_REVISION` and did not change the file; `../outside.txt`
  returned `PATH_REFUSED` without host-path leakage.
- Legacy `fs_search` (no `contract_version`), `fs_read_many(paths=...)`, `fs_read`,
  `fs_write_many`, and legacy `apply_patch_many` all succeeded.
- `activity_recent` showed the committed patch as `succeeded`/`PATCH_APPLIED` and the stale
  hash as `failed`/`STALE_REVISION`; the explicit cleanup `shell_run` audit contained the
  host path, but the `PATH_REFUSED` response itself did not.
- The large-file round was read-only; smoke files created in the earlier round were removed.

## Rollback

See `.p05/backups/deployment-20261028/ROLLBACK.md`. Prefer the reviewed F6 baseline when
rolling back only the large-file/search feature:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\stop-runtime-slot.ps1 -Slot A
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\stop-runtime-slot.ps1 -Slot B
git switch --detach 5ef4e88
& .\.p05\tools\node\npm.cmd run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\run-runtime-slot.ps1 -Slot A
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\run-runtime-slot.ps1 -Slot B
```

`5ef4e88` keeps all F1—F6 safety fixes while dropping the newer streaming/search changes.
`0a1ddf8`/`7d491b9` are full pre-remediation candidates and also remove F1—F6 fixes; use them
only for an intentional full rollback. Restore `.env`/state from the same backup directory only
while the affected slot is stopped.

## Production search coverage note (historical 32 MiB run)

The first ChatGPT connector root searches stopped at the old fixed 32 MiB scan limit. This
was expected partial coverage, not an `SEARCH_COMPLETE` regression:

| Slot | Path | Scanned files | Scanned bytes | Stop reason | Outcome |
| --- | --- | ---: | ---: | --- | --- |
| A | `.` | 1,317 | 33,375,271 | `byte_limit` | `SEARCH_TRUNCATED` |
| B | `.` | 255 | 32,137,305 | `byte_limit` | `SEARCH_TRUNCATED` |

`max_results` limits represented results and `max_bytes` limits the response payload; neither
changes the 32 MiB scan budget. To verify `SEARCH_COMPLETE`, use a scope that fits the budget:

| Slot | Path | Scanned files | Scanned bytes | Stop reason | Outcome |
| --- | --- | ---: | ---: | --- | --- |
| A | `docs` | 22 | 318,247 | `exhausted` | `SEARCH_COMPLETE` |
| B | `slprj` | 271 | 3,672,074 | `exhausted` | `SEARCH_COMPLETE` |

The old `nextAction` also said "raise max_results" for every scan-limit stop. For `byte_limit`
that was imprecise; narrowing `path`/`query` was the available workaround.

## Large-file and search-capacity improvement (2026-10-28)

The reviewed build now supports both requested cases:

- `fs_read_many` V2 streams files above the 2 MiB snapshot limit instead of failing. Only the
  requested line window is retained; the full stream is hashed and UTF-8 checked. Default
  streamed-file cap is 64 MiB, configurable to 256 MiB via
  `REMOTE_AGENT_MAX_RANGE_READ_BYTES`.
- Search scan budget is configurable via `REMOTE_AGENT_MAX_SEARCH_BYTES` (default 128 MiB,
  hard cap 1 GiB). Search can read individual text files up to 8 MiB via
  `REMOTE_AGENT_MAX_SEARCH_FILE_BYTES`; larger files are still reported as `oversized`.
- The production `.env` sets a 256 MiB range cap and a 1 GiB search scan budget. With this
  budget, both production roots now report `SEARCH_COMPLETE`:

| Slot | Path | Scanned files | Scanned bytes | Stop reason | Outcome |
| --- | --- | ---: | ---: | --- | --- |
| A | `.` | 3,759 | 590,566,721 | `exhausted` | `SEARCH_COMPLETE` |
| B | `.` | 3,466 | 824,745,209 | `exhausted` | `SEARCH_COMPLETE` |

The cost is latency: the two complete root scans took about 37 seconds together in the local
read-only probe. A 1 GiB scan is not free; narrow `path` remains preferable for routine work.
- `max_bytes` still only controls response payload (64 KiB default/256 KiB hard cap). A
  streamed large-file read may return a page with `nextOffset`; that is expected and
  independent of the file-size cap.
- Production A/B were restarted on the new build; Runtime A PID 29400 (18:20:47) and Runtime B
  PID 560 (18:20:50), both `/readyz=ready`.
- If a scope contains only oversized files, search still reports `SEARCH_COMPLETE` because the
  directory scan completed, but `skippedByReason.oversized` is non-zero and `nextAction` now
  says those files were not searched and points to `fs_read_many` or the per-file search limit.

### Read outcome triage

| Code | Meaning | Action |
| --- | --- | --- |
| `READ_TOO_LARGE` | The whole file exceeds the configured streamed-range cap (production 256 MiB). No content was read. | Use a smaller file, raise `REMOTE_AGENT_MAX_RANGE_READ_BYTES` within the 256 MiB hard cap, or split the file. |
| `LINE_TOO_LARGE` | One requested line is longer than the response `max_bytes`; the file/version hash and `totalLines` may still be returned. No `nextOffset` is emitted because a line cannot be split safely by line range. | Increase `max_bytes` up to 256 KiB, or use a byte-chunk reader. A smaller line range does not help for a single line. |
| `READ_TRUNCATED` | The request succeeded but only part of the requested lines were returned. | Not an error; continue with `nextOffset` (or `pendingIndexes` for a batch). |

A 3.64 MB single-line JSON file therefore correctly returns `LINE_TOO_LARGE`, not
`READ_TOO_LARGE` and not `READ_TRUNCATED`. Multi-line large files return normal
`READ_TRUNCATED` pages.

## Residual risks

- Independent code-review coverage ends at `5ef4e88` (F6). Large-file streaming, configurable
  search and read-limit triage are covered by tests and deployment smoke, but have not received
  a separate full independent review.
- Production processes were replaced while their old in-memory revision was not stamped;
  rollback is by known git revision, not by a saved old binary.
- No OS-level CAS, crash atomicity, cross-process lock or hardlink/TOCTOU guarantees; see the
  remediation evidence for the standing limitations.
- Large-file streaming still reads and hashes the whole file for each range request; very
  large files have I/O cost even when only a few lines are returned.
- A root-wide search at 1 GiB can take tens of seconds and still stops at the hard cap; narrow
  scopes remain preferable. Search pagination/cursor is still not implemented.
- Files above the 8 MiB per-file search cap are skipped as `oversized`; a zero-match result
  requires inspecting `skippedByReason`. Files above 64 MiB cannot be searched even after
  raising that setting.
- A single line above the 256 KiB response cap cannot be returned by line range; no byte-chunk
  reader exists yet.
- Legacy `fs_read` / `fs_read_many(paths=...)` retain the 2 MiB `maxReadBytes` behavior; use
  the V2 range contract for large files.
- Benchmark figures remain protocol-only and were not rerun solely for this deployment.
