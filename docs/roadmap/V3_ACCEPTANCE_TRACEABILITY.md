# V3 Acceptance Traceability — T01–T70

Baseline: docs/architecture/P05_V3_TECHNICAL_SOLUTION.md §34–§38. This file is the executable acceptance ledger for the current V3 branch.

Status semantics: PASS means the mandatory observation is covered by current evidence; PARTIAL means only part of the scenario is covered; NOT_RUN means no complete acceptance evidence has been collected; N/A requires an explicit applicability rationale. A module or unit test existing is not by itself a PASS.

| ID | Status | Evidence | Gap / closure |
|---|---|---|---|
| T01 | PARTIAL | V2 test:compiled; src/test/v3-v2-regression.ts | Core V2 regression is gated; live MATLAB and deployment applicability remain separate |
| T02 | NOT_RUN | none | Need A/B different-workspace test with A restart while B has live work |
| T03 | PASS | v3-core optional-failure/hang tests; v3-application broken workflow catalog | Bad optional startup/config is bounded and reports DEGRADED while Core liveness and minimal read path remain available |
| T04 | PASS | protected trust manifest validation plus diagnostics-only application LOCKED path and recovery boundary | Missing/unprotected/invalid/mismatched configured trust manifests cannot start execution backends; mismatch acceptance proves LOCKED core_status remains available while execution and capability surfaces return CORE_LOCKED |
| T05 | PASS | v3-core, v3-recovery, host ownership-lock tests | Slot ownership and stale-owner fencing are exercised |
| T06 | PASS | v3-core 64-way reconcile flood plus persistent crash-loop restart budget | Reconcile flood starts one child only; repeated crashes latch CRASH_LOOP until explicit recovery |
| T07 | PASS | v3-durable, v3-application | Stable execution identity and non-terminal wait timeout covered |
| T08 | PASS | lifecycle durable state machine, RPC ackBarrier, v3-main supervisor restart, v3-lifecycle reconnect acceptance | Restart intent is durable before acknowledgement; dispatch is released only after response finish; Core generation advances and reconnect observes a SUCCEEDED supervisor health receipt; idempotent retry does not restart twice |
| T09 | PASS | v3-process-bridge, v3-recovery | External process survives Core observation loss and reconciles to original Run |
| T10 | PASS | v3-durable, v3-process-bridge, v3-recovery | Crash windows preserve UNKNOWN and prohibit blind replay |
| T11 | PASS | v3-durable | Idempotency identity/conflict behavior covered |
| T12 | PARTIAL | durable/process/terminal timeout tests | SSH/session timeout classes are not implemented |
| T13 | PASS | v3-durable event sequence/cursor; v3-application fresh-client cursor continuation and Operator/MCP terminal parity | Cursor resumes without replay and authenticated Operator/MCP views agree on terminal Run version/result |
| T14 | PASS | v3-durable, v3-application, v3-recovery | Approval-linked Run survives restart |
| T15 | PASS | v3-durable, v3-application | Approval CAS and single-side-effect continuation covered |
| T16 | PASS | v3-durable, v3-application | Deny/cancel/late-decision behavior covered |
| T17 | PASS | v3-durable pending approval freezes workspace/input and rejects replacement binding; v3-application revalidates content/link/auth revision | Pending approval cannot be retargeted by context/input/binding or external target changes |
| T18 | PASS | v3-durable pre-dispatch queue plus uncertain dispatch reservation | Original approval survives pre-dispatch waiting without a second decision; after dispatch reservation UNKNOWN cannot refund or reuse it |
| T19 | PARTIAL | V2 operator tests; V3 approval metadata | V3 contextual queue and fast-approval UI path are incomplete |
| T20 | PASS | v3-durable terminal receipt survives deliberate audit-event deletion | SUCCEEDED Run/result remains authoritative with receipt intact even when audit events are absent |
| T21 | PARTIAL | V2 policy profiles; V3 authorization tests | Full hierarchical Grant/revocation/version matrix is not closed |
| T22 | PASS | v3-protection, v3-application | Real-path, ACL, link/junction and write-boundary checks covered |
| T23 | NOT_RUN | none | Production OS-denied immutable Runner/policy/Slot-data test requires strong isolation backend |
| T24 | PARTIAL | application/process approval boundary; component external-effect rejection | Plugin/downstream/Agent paths are not all proven through one backend ceiling |
| T25 | PARTIAL | v3-component-host | Crash/infinite-loop isolation covered; output limiting and cross-Slot hostile-read incomplete |
| T26 | NOT_RUN | isolation backend reports unavailable | Production network deny/allowlist/DNS/proxy enforcement not implemented |
| T27 | PASS | v3-secret-boundary plus v3-process/v3-process-bridge/v3-durable/T41/T67/application regressions | Run state persists SecretRef rather than plaintext; resolver is not invoked before approval and dereferences only at execution; Process Host persists redacted command args and stream-redacts stdout/stderr before storage; resolver failures collapse to stable codes; ArtifactStore can apply the same secret redaction policy before content-addressed persistence; secret-scanned backup materialization fails closed on any known plaintext credential |
| T28 | PASS | v3-isolation | Strong-isolation request fails closed when backend is unavailable |
| T29 | PASS | v3-process, v3-process-bridge, v3-terminal | Owned-process cancellation and termination semantics covered |
| T30 | PARTIAL | v3-terminal real ConPTY test | PTY I/O/resize/paging bounded; malicious terminal-sequence UI rendering not tested |
| T31 | NOT_RUN | none | SSH host-key first-connect/change flow not implemented |
| T32 | NOT_RUN | none | SSH principal/jump-host/remote-root rebinding not implemented |
| T33 | NOT_RUN | none | Authorized remote development session behavior not implemented |
| T34 | NOT_RUN | none | raw SSH/Worker reconnect and receipt semantics not implemented |
| T35 | NOT_RUN | none | Remote session expiry/revocation/offline propagation not implemented |
| T36 | NOT_RUN | none | Transport-neutral HostSession contract test not implemented |
| T37 | PASS | v3-resources, v3-resource-host | Cross-Slot resource contention and lease compatibility covered |
| T38 | PASS | v3-resources, v3-resource-host | Lease expiry/fencing/recovery behavior covered |
| T39 | PASS | v3-resources, v3-resource-host | Multi-resource ordering/cancel/restart reconciliation covered |
| T40 | PASS | v3-git-worktree real concurrent Git worktrees plus existing workflow parallel and Git mutation regressions | Two writers start from the same base in isolated worktrees; integration requires validation, authorization and a revalidated integration guard; candidate changes are limited to declared writeIntent; a conflicting second candidate is detected in a detached preview and leaves target HEAD/content unchanged while retaining the conflicting worktree and commit |
| T41 | PASS | v3-reference-artifact-gc plus profile-exposure/v3-protection/v3-git-worktree regressions | Reference surface remains read-only and canonical containment rejects protected/shared .git metadata and linked escapes; worktree writeIntent forbids shared Git metadata; durable content-addressed ArtifactStore preserves active-run/pending-review/pin/rollback references, keeps shared blobs while referenced, and performs bounded orphan/expired GC only after protections clear |
| T42 | PASS | v3-plugin-controller real Runtime restart acceptance; V2 plugin framework/API/operator regressions; v3-component-host manualHold persistence | Operator stop persists desired=enabled/manualHold=true in Slot-local controller state; Core/Slot restart does not auto-restart held plugins; explicit start clears hold; explicit restart remains enabled; controller revision and observed state are durable |
| T43 | PASS | v3-downstream-containment hostile MCP fixture; downstream smoke; v3-component-host isolation | Official MCP schema rejection quarantines malformed results, downstream process loss invalidates the connection, health records only safe failure categories, and a clean reconnect succeeds without affecting component/Core isolation |
| T44 | PASS | v3-component-host, v3-composition | In-flight binding revision pinning and replacement behavior covered |
| T45 | PASS | v3-component-host, v3-composition | Activation failure, dependency lifecycle and disposal semantics covered |
| T46 | PASS | v3-authorization-invariance plus v3-composition and v3-component-host regressions | Shadow scopes cannot reach the real external-effect manager; interceptor deny is monotonic; actor/authority/approval envelope fields are immutable; exception/timeout/invalid interceptor output fail closed; protected trust/authorization/storage-integrity/updater services cannot be published or hot-replaced by ordinary components |
| T47 | PASS | v3-agent-providers real CLI JSONL + IPC protocol subprocess acceptance; existing v3-workflows regressions | Two distinct subprocess Agent Provider adapters share the durable invocation contract; platform-generated permits bound internal tools; self-approval claims cannot grant authority; internal tool calls and provider iterations are metered into the Run budget; call/iteration/timeout exhaustion stop boundedly; unsupported constrained/isolated modes are refused |
| T48 | PASS | v3-workflows contract/revision acceptance plus persisted definition snapshots | Missing schema/capability/DoD/budget fail before activation; same-revision content changes are rejected; existing Runs retain pinned skill revision/content digest while only explicitly selected new Runs adopt revision 2 |
| T49 | PASS | SkillActivationRouter unit acceptance plus workflow-service/Application routed-start integration | Deterministic precedence is explicit > workflow-handoff > evidence-backed intent; project rules and caller scope can only restrict authority; untrusted text is audit-only and cannot select targets or grant authority; conflicts fail explicitly and activation source/reason are persisted |
| T50 | NOT_RUN | asset/component lifecycle pieces only | Full Skill install/upgrade/rollback/disable/cross-Host provenance not implemented |
| T51 | PASS | v3-workflows | Stage progression and controlled handoff covered |
| T52 | PASS | v3-workflows | Invalid/missing workflow contracts and bounded routing covered |
| T53 | PASS | v3-workflows, v3-workflow-scheduler, v3-recovery | Restart/checkpoint continuation without replay covered |
| T54 | PASS | v3-resource-workflow real Workflow+ResourceCoordinator integration; v3-workflows/scheduler/resources/resource-host/application regressions | Parallel branches are admitted through ResourceConstrainedExecutor; exclusive resources serialize real inner execution; multi-resource waits are atomic with no partial reservation; fencing permits are platform-generated and validated; bounded resource expiry produces explicit branch failure, cancel-siblings cleanup and lease release without hidden tool-call retries |
| T55 | PARTIAL | workflow cancellation plus process cancellation tests | SSH child cancellation absent and full propagation chain not closed |
| T56 | NOT_RUN | none | Generic desired/observed controller for Reviewer/Tunnel not implemented |
| T57 | PARTIAL | V2 http-reviewer regression | V3 managed-service/Slot authorization integration remains |
| T58 | PARTIAL | V2 operator-console regression; approval CAS tests | V3 multi-window CSRF/close-window acceptance not complete |
| T59 | NOT_RUN | none | Candidate upgrade failure and A/B rollback workflow not implemented |
| T60 | NOT_RUN | none | Schema migration, online backup/restore and incompatible rollback not implemented |
| T61 | NOT_RUN | none | Package authenticity/expiry/offline/native-ABI install gate not implemented |
| T62 | NOT_RUN | none | Linux minimum-contract suite not executed |
| T63 | NOT_RUN | none | Multi-device delegation/receipt/artifact transfer not implemented |
| T64 | NOT_RUN | none | 24-hour dual-Slot soak/capacity acceptance not executed |
| T65 | PASS | V3 application capability-catalog startup gate and public catalog assertions | Startup rejects missing or invalid effect/execution identity/backend metadata and requires an exact declaration for every registered capability |
| T66 | NOT_RUN | none | Sleep/time-change/remote-restart lease-expiry acceptance not executed |
| T67 | PASS | v3-asset-artifact-security plus v3-reference-artifact-gc/v3-composition/v3-component-host/application regressions | Artifact queries are bound to principal/workspace visibility and hide denied ids; blob digest substitution is detected before read; promotion claims pin source Artifacts against GC and Asset provenance records artifact/run/digest; forged promotion bytes are rejected; only exact-digest ACTIVE Asset revisions resolve for execution, while DRAFT/VERIFIED/REVOKED revisions do not; released provenance references become collectable |
| T68 | PARTIAL | V2 regression under V3 worktree | Real V2 config/history migration and stale-approval non-revival drill remains |
| T69 | NOT_RUN | none | Disk-full/WAL/backup-failure/log-flood fail-closed acceptance not executed |
| T70 | PARTIAL | V3_LOCAL_DEVELOPMENT_HANDOFF.md | Formal independent Runbook handoff drill not executed |

## Gate policy

npm run verify:v3 is the local source gate. It must compile once, run the V2 compatibility regression inside the V3 workspace, run all default V3 suites including Component Host, Isolation fail-closed inventory and Terminal, and validate this matrix.

A green gate does not convert PARTIAL or NOT_RUN rows to PASS. Those rows close only when their mandatory §34 observations have concrete evidence. Strong-isolation POCs, live MATLAB/hardware, SSH/Linux, multi-device and long-duration tests remain separate environment-specific gates until their production paths exist.
