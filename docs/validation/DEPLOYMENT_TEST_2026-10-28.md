# P05 F6 Deployment Acceptance — 2026-10-28

## Scope

- Branch: `codex/v2-agent-workflow-pilot`
- Tested HEAD: `5ef4e88` (F6)
- Full code verification before deployment: `npm run verify` → 1,860 checks; benchmark last run
  on the unaffected F5 path → 69 checks/40 runs. F6 did not change benchmark scenarios.
- No feature work, no code re-review, no push/merge.

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

- Runtime A restarted as PID **51980** at 2026-10-28 16:21:53; Runtime B as PID **5784** at
  2026-10-28 16:22:49.
- Both tunnel `/readyz` checks returned `200 ready`.
- `dist/index.js` SHA-256 remained
  `94450D503A60DF035A64C03C0DF78A5B5E1ED5C82E58BA2D0364EAA587CE5082` (the tested F6 build).
- Existing tunnel profiles, `.env`, workspace bindings, profiles and approval mode were not
  changed. Agent version remains `0.3.1`.
- The local operator bridge is created when an MCP session initializes; no ChatGPT connector
  session was initiated from this environment. The user-side connector should perform one
  read-only smoke (`device_info` / `fs_search` / `fs_read_many`) to confirm the connector path.

## Rollback

See `.p05/backups/deployment-20261028/ROLLBACK.md`. Summary:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\stop-runtime-slot.ps1 -Slot A
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\stop-runtime-slot.ps1 -Slot B
git switch --detach 0a1ddf8
& .\.p05\tools\node\npm.cmd run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\run-runtime-slot.ps1 -Slot A
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\run-runtime-slot.ps1 -Slot B
```

`0a1ddf8` is the conservative pre-remediation candidate; use `7d491b9` if the A4 baseline is
preferred. Restore `.env`/state from the same backup directory only while the affected slot is
stopped.

## Production search coverage note (2026-10-28)

The ChatGPT connector's root searches on both production workspaces stopped at the fixed
32 MiB scan limit. This is expected partial coverage, not an `SEARCH_COMPLETE` regression:

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

The current `nextAction` says "raise max_results" for every scan-limit stop. For `byte_limit`
that wording is imprecise; narrowing `path`/`query` is the available workaround. A
root-wide complete search over a workspace larger than 32 MiB would require a new scan-budget
or pagination contract, which is outside F6 and was not added.

## Residual risks

- The independent acceptance client is a real Streamable HTTP MCP client, but not the user's
  ChatGPT connector. Connector-level authentication/tunnel behavior still needs the user-side
  smoke above.
- Production processes were replaced while their old in-memory revision was not stamped;
  rollback is by known git revision, not by a saved old binary.
- No OS-level CAS, crash atomicity, cross-process lock or hardlink/TOCTOU guarantees; see the
  remediation evidence for the standing limitations.
- Benchmark figures remain protocol-only and were not rerun solely for this deployment.
