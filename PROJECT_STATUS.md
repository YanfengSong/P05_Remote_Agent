# Project Status

Updated: 2026-10-28

## Current deployment progress - 2026-10-28

This snapshot takes precedence over the historical baseline and validation counts below.
The reviewed source is the user-designated latest checkout, `D:\Project_Git\P05_V2_Deployment`.
Version remains **0.3.1**, with **V2** as the cloud synchronization target; this is not a main-branch release.

### Delivered in this snapshot

- A1 versioned range reads (`fs_read_many` V2): raw-byte SHA-256, line ranges,
  `totalLines`, `nextOffset`, `pendingIndexes`, strict UTF-8/binary handling and a bounded
  whole-MCP-result budget.
- A2 same-revision multi-edit (`apply_patch_many` V2): 1–100 edits per file, overlap/ambiguity
  rejection, `dry_run`, bounded diff preview, shared in-process write locks, and honest
  `rolled_back` / `unknown` rollback outcomes.
- A3 search coverage (`fs_search` V2): `complete`, `stopReason`, `scannedFiles`,
  `skippedByReason`, unified `outcome`, MCP `isError` and audit failure classification.
  Normal read/search truncation remains successful with truncation metadata; genuine failures
  are audited as failed. Unknown write effects use `retry=never_automatic` and human recovery.
- A4 protocol benchmark: four fixed scenarios across legacy and V2, five measured runs per
  variant, real stdio MCP client, actual response bytes and local round-trip time. See
  `docs/validation/MCP_FILE_CONTRACTS.md`. This is a protocol benchmark only; no model was
  involved, so no model latency or token-saving conclusion is made.
- A1—A4 remediation (M1—M7): final read-budget finalization, bounded snapshots and complete
  writes, canonical missing-ancestor locks with locked preflight/dry_run, R03 budgets for
  V2 search/patch, structured/redacted V2 path failures, line-window scanning without
  full-file arrays, and observed retry/audit evidence. See
  `docs/validation/MCP_FILE_CONTRACTS_REMEDIATION.md`.
- Closure review F1—F6: post-write effect envelopes always retain status/hash/effect within
  budget, rollback verifies path identity before and after restoration, search response
  trimming preserves scan-level `matchesTruncated` and budget guidance, V2 search errors omit
  unbounded metadata, retry metrics are attributed by canonical target + version, and a
  created file whose first identity query fails is preserved and reported as unknown rather
  than as zero change. See the same remediation evidence document.
- Batch file reading, bounded literal search, batch writes, batch patches and
  `git_workspace_audit` remain available; legacy calls keep their prior output shapes.
- Mutation batches preflight paths and expected hashes, reject ambiguous targets, and attempt
  rollback on ordinary write failures. They do not claim crash-atomic filesystem transactions.
- `project_validate` groups fixed allowlisted validation actions under the normal approval gate.
- 2026-10-28 deployment acceptance: an isolated Streamable HTTP instance passed the full
  search → range read → multi-edit dry_run/commit → audit flow plus stale-hash, truncation,
  path-refusal and legacy-call checks (65 assertions, 19 MCP calls). Production Runtime A/B
  were then restarted on the tested build and both `/readyz` checks returned ready. The same
  deployment now streams large V2 range reads (64 MiB default/256 MiB cap) and configures a
  1 GiB search scan budget; both production roots report `SEARCH_COMPLETE`. See
  `docs/validation/DEPLOYMENT_TEST_2026-10-28.md`; rollback baseline and commands are under
  `.p05/backups/deployment-20261028/`.
- Legacy `fs_read` is hidden by default; `P05_EXPOSE_LEGACY_FS_READ=1` enables compatibility.
- Capability metadata, live activity summaries, profile exposure, HTTP Reviewer and output
  schema regressions cover the current tool surface.
- Machine-local `.env.bak*` files are ignored alongside existing `.env` and `.p05/` exclusions.

### Verification on 2026-10-28

Typecheck and build passed. All suites listed by `npm run verify` were exercised successfully
with the repo-local Node v22.23.1:

| Suite | Explicit checks |
| --- | ---: |
| Policy profiles | 335 |
| Profile exposure | 266 |
| HTTP Reviewer | 80 |
| Foundation | 58 |
| File contracts | 644 |
| Git mutations / workspace audit | 27 |
| Operator Console | 93 |
| Output schemas | 328 |
| Plugin framework | 35 |
| Plugin API v1 | 4 |
| State synchronization | 11 |
| File I/O primitives | 19 |
| **Total** | **1,900** |

Downstream smoke passed as part of `npm run verify`. `npm run verify` ran
`check`, `build`, `test:compiled` and `test:sync` to completion.

The A4 benchmark is a separate evidence command (`npm run test:benchmark`), not part of the
per-commit correctness gate. It reported 40 measured runs, `FILE_CONTRACTS_BENCHMARK_OK
(69 checks, 40 runs)`, 5/5 correctness in every scenario/variant, zero unsafe retries in the
normal workflows, a safe retry trace with one observed conflict and a deliberately stale
negative trace with one unsafe retry, a real multi-target trace with one attributed conflict
and no unsafe sibling retry, and an A1 error response maximum of 939 bytes under
`max_bytes=4096` including `isError`.

### Open operational follow-up

`BoonrayB_Latency_Test_20261022.md` records an earlier finding that old and current B Runtime
instances shared the same tunnel profile and requests alternated between them. This sync
does not independently establish whether that incident has since been resolved. Live route
acceptance remains a separate follow-up; the automated test results above do not prove it.

## Historical baseline

## Baseline

Version: **0.3.1**
Repository: **YanfengSong/P05_Remote_Agent**
Release integration target: **develop -> main**
Review-fix staging branch: **plugins**
Main merge: **pending external-review closure**
Milestone: **Foundation V2 operational / final integration review closure**

P05 is now a multi-Workspace remote engineering Agent platform rather than a tool collection tied to the P05 source directory.

## Core path verified

    ChatGPT -> tunnel/MCP -> P05 -> Workspace/Policy -> Runtime
            -> Files/Git/Shell/Plugins/Downstream
            -> Audit/Recovery

Repeated runtime restart/reconnect has been verified.

## Foundation V2

### Workspace

- registered logical Workspaces;
- exactly one `platform-source`;
- active Workspace can be switched only by logical id;
- structured file access is confined to the active Workspace;
- Git operations target the active Workspace;
- shell starting cwd is confined to the active Workspace;
- optional Workspace plugin allowlist;
- roots are canonicalized and junction/symlink root escape is refused.

### Platform

`command_run` is explicitly bound to the platform-source root.

A business Workspace can be active while `command_run(check)` still validates P05.

### Capability / Policy

Core metadata has one canonical source:

`src/capability/registry.ts`

Descriptors carry:
- name;
- minimum profile;
- risk;
- scope;
- summary;
- optional gate.

Application-plugin capabilities are declared in their plugin manifest and merged into the session catalog.

V2 call-time permission is now centralized through the common Tool Permission Broker (ADR-0020):
- `ALLOW` — execute immediately;
- `CONFIRM` — Local Operator one-time approval;
- `DENY` — refuse the operation.

The Broker is a permission-subsystem refactor only; Runtime A/B, Workspace, Reference, Plugin and Downstream architectures are unchanged.

### Registration

`src/index.ts` is bootstrap/assembly.

Tool groups are modular:
- control;
- fs;
- git;
- execution;
- temporary;
- gateway/plugin;
- device.

### Runtime

Common lifecycle:

    prepare -> authorize -> execute -> verify -> complete
                          |
                          +-> failed

Classified errors:
- policy;
- timeout;
- process;
- tool;
- config;
- interrupted;
- unknown.

### Audit / Recovery

Metadata-only audit is persisted under protected P05 state.

Remote inspection:
- `activity_recent`
- `recovery_status`

A record left running across Agent restart is converted to:
- failed;
- interrupted;
- recoveryHint=inspect.

Raw argument payloads and file content are not stored. Audit may persist a bounded sanitized `inputSummary`; known secret patterns, including SSH identity-file arguments, are redacted.

### MCP output contracts

All current Core MCP tools advertise object-root `outputSchema` and return matching `structuredContent`.
Legacy text content is retained for compatibility.

Regression:
- `OUTPUT_SCHEMA_OK (177 checks)`;
- the current exposed Core tool surface is checked for output schemas;
- every Core tool's MCP `ToolAnnotations` is verified against Capability Catalog risk/scope metadata at the real `tools/list` protocol boundary;
- representative tools are called and verified to return structured objects.

### Operator Console

V2 local Operator Console is integrated into the current Foundation V2 baseline.

Implemented:
- independent loopback GUI process on `127.0.0.1:56301`;
- connect / disconnect / restart controls;
- GUI survives P05 MCP/Tunnel restart;
- local token-protected control bridge from MCP runtime to GUI;
- live Workspace selection;
- Runtime A/B-independent Runtime, Workspace, MCP and Tunnel status;
- Runtime A/B-independent structured Git visibility;
- Runtime A/B-independent Plugin/downstream visibility;
- persistent Audit/Recovery;
- memory-only sanitized Live Activity;
- MCP capability/exposure visibility;
- one-click local launcher.

Current automated regression:
- `OPERATOR_CONSOLE_OK (68 checks)`.

Latest external-review-closure validation on this host executes **850 explicit assertions** across policy, exposure, HTTP Reviewer, Foundation, Git mutation, Operator, output-schema and plugin suites. Build/typecheck and downstream smoke are additional gates.

### Plugins / Downstream

Application-specific integrations use the Plugin layer.

MATLAB/Simulink is the first built-in plugin.

Downstream MCP processes can bind to:
- active Workspace;
- platform Workspace;
- fixed cwd.

Workspace switching changes active-bound downstream context and triggers reconnect when required.

## Current profiles

### discovery
- device_info
- ping

### readonly
- workspace_list
- workspace_current
- activity_recent
- recovery_status
- plugin_list
- fs_read / fs_list
- git_status / git_diff / git_diff_stat
- remote_read (fixed H1/J1 read-only operations)

### developer
- all readonly capabilities
- fs_write / apply_patch
- git_add / git_commit / git_branch
- command_run
- runtime_restart
- mcp_status / mcp_list_tools
- shell_run (behavior-aware common Tool Permission Broker)

### full
- all developer capabilities
- git_push
- mcp_call_tool

## Git mutation

Implemented and tested:
- stage explicit Workspace paths;
- local commit;
- branch create;
- branch switch;
- safe branch delete (`-d`, no force);
- push current HEAD to named remote.

`git_push` remains `full` because it modifies an external remote.

No structured force push or arbitrary refspec is exposed.

## Permission / Shell boundary

ADR-0020 replaces the Shell-specific approval subsystem with one common Tool Permission
Broker.

Current V2 behavior:
- structured reads and Workspace-local structured mutations are low-friction `ALLOW`;
- Workspace-scoped structured MATLAB `model_edit` is `ALLOW`; arbitrary-code/test or unclassified MATLAB behavior remains `CONFIRM`;
- `remote_read` provides fixed H1/J1 read-only operations at readonly profile;
- `shell_run` is behavior-aware: local safe operations and provably read-only SSH may `ALLOW`; bare/forwarding/dynamic/unclassified/mutating SSH remains `CONFIRM`; catastrophic disk/root destructive patterns remain `DENY`;
- current SSH read regressions cover nested H1 -> J1 identity/network/service queries, `passwd -S`, package-status queries and constrained APT-config reads;
- `command_run`, `runtime_restart`, `git_push`, generic downstream execution and remote/system mutations remain `CONFIRM`;
- approval is bound to exact Runtime + Workspace + Tool + Operation + canonicalized arguments;
- approval expires after 15 minutes and is consumed before one execution.

The Runtime cannot approve its own request. P05 Local Operator approval is also not a
promise that an independent upstream client/platform safety layer will execute an
arbitrary high-risk Shell command. Repeated maintenance mutations should move toward
typed maintenance capabilities rather than attempts to bypass that independent layer.

### 2026-09-29 live acceptance

Runtime A live checks verified no-approval execution for H1/J1 `hostname`, J1
`passwd -S`, `ip route`, `systemctl is-active`, `dpkg -s nftables`, and
APT-config `grep` under `/etc/apt`. A remote `touch` remained confirmation-gated
and a cross-Workspace structured write remained denied.

See `docs/handoff/V2_BRANCH_BASELINE_2026-09-29.md` for the branch handoff.

## Validation

Latest full verification after the current permission refactor:

    ACTION verify                 PASS
    Runtime B audit state         succeeded
    Runtime B verify duration     ~67.8 s

Latest targeted permission regression:

    ACTION build                  PASS
    POLICY_PROFILES_OK            264 checks
    PROFILE_EXPOSURE_OK           195 checks
    OPERATOR_CONSOLE_OK           68 checks
    OUTPUT_SCHEMA_OK              176 checks
    PLUGIN_FRAMEWORK_OK           35 checks

Live Tool Approval acceptance:

    Runtime B                    PASS
    Runtime A                    PASS

Both live Runtime checks verified: CONFIRM before execution -> Local Operator
one-time approval -> exact retry executes -> approval consumed before execution ->
subsequent identical call creates a new approval request.

Key V2 acceptance verified:
- cross-Workspace absolute structured write refused;
- cross-Workspace absolute structured read refused;
- refused writes create no side effects;
- platform self-validation survives business Workspace activation;
- platform root remains stable after Workspace switch;
- Capability Catalog is canonical;
- Runtime errors are classified;
- interrupted records survive reload as recovery records;
- downstream target follows Workspace binding;
- Git mutation works against isolated local repositories/remotes;
- Core starts with zero application plugins;
- plugin capability metadata merges into the session Capability Catalog;
- plugin tools are refused after switching to a Workspace that disables the plugin;
- plugin start failure is isolated from Core;
- Core index has no MATLAB-specific import/symbol.

## Remaining foundation boundary

V2 now has a common Tool Permission Broker, but it is not an OS sandbox.

The remaining hard-containment gaps are arbitrary-code isolation, a unified hard execution boundary, and trusted/immutable build-test-restart runners. These are V3 requirements. P05 intentionally does not expand the V2 Shell parser or Permission Broker into a substitute for those mechanisms.

## Architecture V3 research baseline

The complete V3 target architecture is now defined independently of implementation slicing.

The research-backed target adds:

- stateless Protocol Edge and explicit application handles;
- Durable Run Kernel + transactional State Store;
- separate Process, Terminal, Work Isolation and Security Isolation contracts;
- effect/idempotency-aware execution and durable approvals/resource leases;
- one semantic Capability Catalog with versioned Bindings;
- distinct Asset and Artifact lifecycles;
- provider-neutral Agent Runtime;
- bounded Skill Runtime;
- deterministic Orchestrator;
- multi-device and optional isolated/GUI Worker extension points.

V3-A remains one possible early implementation slice and MUST conform to the complete V3 contracts rather than define
or narrow them.

## Integration / working tree

The 2026-09-29 V2 permission / remote-execution baseline is finalized first on
`feature/shell-approval-gate`. After this baseline commit is pushed, a long-lived
`V2` branch is created from the exact same commit and becomes the development line
for subsequent V2 work.

`main` remains the release branch. Promotion from `V2` to `main` requires an
explicit integration/release decision and a fresh full verification; branch naming
alone is not release evidence.

V3 architecture/research documents may live alongside V2 implementation code as
design inputs, but implementation work on the `V2` branch must not claim unimplemented
V3 contracts as delivered behavior.

## Plugin architecture references

- `docs/architecture/PLUGIN-FRAMEWORK.md`
- `docs/adr/ADR-0011-plugin-framework.md`

## Universal deployment V2

The V2 deployment path is now machine-neutral for the supported Windows x64 target.

P05 V2 also enforces a Repo-Root Contained Runtime invariant: persistent P05 state, managed caches and generated runtime assets remain under the Git repository. `npm run path:audit` is the deployment path audit.

Canonical deployment and state-sync guide: `docs/deployment/P05_V2_UNIVERSAL_DEPLOYMENT.md`. Git/V2 is the distribution source for application code and the portable Golden State manifest; Boonray is not a runtime dependency.

The committed repository is the source of truth for GUI, Core backend logic, Policy/Permission, Runtime lifecycle, Workspace/Reference, Plugin/Downstream behavior, Audit/Recovery and deployment scripts. Active deployment assets contain no Boonray/XiaoiWu host identity or fixed local repository path.

Bootstrap derives paths from the repository location and installs the pinned Node.js/tunnel-client into .p05/tools. .env and .p05 remain machine-local; Device ID, Tunnel IDs, API keys, connector names, application installations and workspace roots are never copied between hosts.

Added scripts/deployment/test-universal.ps1 as a regression gate for this contract. scripts/verify.ps1 now uses the repo-local Node/npm toolchain instead of relying on a globally installed Node.js runtime.

The current portability boundary is intentional: V2 deployment is Windows x64 only. Cross-platform macOS/Linux packaging is not claimed as implemented.

## V2 Universal Edition acceptance

Clean-room validation has been completed from a fresh Git clone with repository-local Node/npm, fresh dependencies, fresh build output and fresh .p05 state. Universal deployment checks and the complete V2 verification suite pass.

HTTP Reviewer is now profile-aware. Its default remains readonly; developer/full profiles require explicit P05_TOOL_PROFILE configuration, and write/Shell/Git mutation paths remain behind Workspace guards and the Permission Broker.

Host-specific names and paths remain only in historical handoff documentation and the universal regression guard that intentionally searches for forbidden identities. They are not runtime bindings or shipped machine state.

The remaining unverified item is physical two-host Tunnel/Connector interoperability. This does not block code-level universal deployment acceptance, but it remains required before claiming multi-host network acceptance.


## Target Architecture V3

Architecture V3 is **accepted as the complete long-term target and technical research baseline; it is not yet fully
implemented**.

Canonical target stack:

```text
Client / ChatGPT
  -> Protocol Edge
  -> Orchestrator / Skill / Agent / Capability services
  -> Policy + Durable Run Kernel + Execution Runtime
  -> Capability Binding / Plugin / Verified Asset
  -> Host Session / Process / Terminal / Worker / Isolation
  -> Engineering host / applications / hardware
```

Key V3 decisions:

- MCP transport/session state is not P05 application state;
- long-running domains share one Durable Run Kernel;
- SQLite is the reference local transactional State Store behind an abstraction;
- Process and interactive Terminal Drivers are separate;
- Git worktree isolation is not an OS sandbox;
- Capabilities are semantic contracts with versioned implementation Bindings;
- Capability effect class constrains retry/recovery;
- Agents are actors, not Capabilities;
- Skills are typed bounded workflows;
- Orchestrator is deterministic coordination, while ChatGPT remains the high-level reasoning authority;
- Assets are reusable implementations; Artifacts are Run outputs;
- parallel writers require explicit reconciliation;
- device-local authority remains authoritative in future multi-device execution.

Canonical V3 documents:

- `docs/architecture/TARGET_ARCHITECTURE_V3.md`
- `docs/research/V3_TECHNICAL_RESEARCH.md`
- `docs/architecture/AGENT-SKILL-ASSET-CONTRACTS.md`
- `docs/architecture/TARGET_ARCHITECTURE_V3A.md` (implementation slice only)
- `docs/adr/ADR-0012-agent-skill-orchestrator.md`
- `docs/adr/ADR-0014-protocol-edge-explicit-handles.md`
- `docs/adr/ADR-0015-durable-run-kernel-state.md`
- `docs/adr/ADR-0016-host-session-terminal-isolation.md`
- `docs/adr/ADR-0017-capability-bindings-assets.md`

## V3 composition-kernel refinement

The complete V3 target now adds a second, orthogonal runtime mechanism below Agent/Skill/Application layers:

- **Trust / Durable Kernel** — identity, Workspace authority, immutable ExecutionContext, Policy/Approval, Durable Run, State/Invocation/Audit and security execution modes;
- **Composition Kernel** — Context, typed Service graph, Component/Fiber lifecycle, E1 local-effect ownership, reactive dependencies, scoped composition and graph reconciliation.

Critical boundaries:

- Context is live composition state; ExecutionContext is immutable execution/authority state.
- Fiber is one live Component instance; Run is durable work.
- Plugin is package/distribution/ownership; Component is the runtime composition unit.
- only E1 local effects are automatic Fiber cleanup.
- E2 resources and E3/E4 engineering mutations remain durable execution/resource effects.
- provider retirement blocks new selection before bounded drain/quiescence.
- Composition Profiles/Bundles never imply Permission/Tool Profiles.
- the Trust/Durable Kernel is excluded from ordinary self-HMR.

DeepSeek Harness/Cordis is the benchmark for Context/Fiber/Effect/reactive-dependency semantics, not a security model copied wholesale.

Additional canonical documents:

- `docs/architecture/CONTEXT-COMPONENT-RUNTIME.md`
- `docs/research/DEEPSEEK_HARNESS_CORDIS_BENCHMARK.md`
- `docs/adr/ADR-0018-trust-kernel-context-component-runtime.md`

Additional composition POCs:

7. typed Context/Service graph with provide/require/isolate/intercept;
8. Fiber structural cleanup and async drain;
9. dependency loss/reappearance lifecycle;
10. Agent/Workspace scoped Capability/Tool contribution layers;
11. provider hot replacement while durable Run metadata survives;
12. Shadow Context candidate validation;
13. declarative Component graph reconciliation;
14. E1/E2/E3/E4 effect-class enforcement.

V3-A remains an implementation slice derived from the complete V3 target and cannot redefine or narrow these contracts.
Technical POCs still required before freezing implementation technology:

1. MCP 2026-07-28 + current tunnel/client compatibility;
2. node-pty/ConPTY interactive Agent sessions;
3. Windows Job Object process-tree supervision;
4. SQLite crash/recovery/concurrency behavior;
5. parallel Git worktree reconciliation;
6. Windows Sandbox/isolated Worker suitability.
