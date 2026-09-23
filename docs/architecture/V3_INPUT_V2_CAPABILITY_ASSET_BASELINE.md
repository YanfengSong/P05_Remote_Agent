# P05 V2 Capability Asset Baseline

Status: V3 design input
Source baseline: P05 V2 / current implemented system
Purpose: record capabilities that already exist in V2 before V3 architecture design
Rule: this document inventories V2 assets only; it does not define V3 redesign decisions

## 1. Baseline principle

P05 V3 is designed from the working V2 system.

The capabilities in this document are treated as existing assets unless later evidence shows otherwise.

This document therefore answers only:

> What capabilities already exist in V2?

It does NOT answer:

- how V3 should redesign them;
- whether they belong in Core;
- whether they should be replaced;
- which V3 abstraction should own them.

## 2. Capability asset summary

| ID | Capability Domain | V2 Implemented Capability | Primary Interface / Carrier | Status |
| --- | --- | --- | --- | --- |
| V2-CAP-001 | MCP Connectivity | P05 exposes local host capabilities through MCP | OpenAI Tunnel / stdio | Implemented |
| V2-CAP-002 | Dual Runtime | Runtime A and Runtime B can run independently | Tunnel A/B + Runtime A/B | Implemented |
| V2-CAP-003 | Runtime Isolation | A/B maintain separate state, Workspace, Audit, Plugin and Downstream state | .p05/runtime-a / runtime-b | Implemented |
| V2-CAP-004 | Device Identity | Device/host/runtime identity and version query | device_info | Implemented |
| V2-CAP-005 | Liveness | Runtime online check | ping | Implemented |
| V2-CAP-006 | Workspace | Registered project Workspace and active binding | Workspace Manager | Implemented |
| V2-CAP-007 | Reference Root | Multiple read-only reference roots per Runtime | Reference Manager | Implemented |
| V2-CAP-008 | Capability Catalog | Unified capability metadata | Capability Registry | Implemented |
| V2-CAP-009 | Tool Profiles | discovery / readonly / developer / full | Policy / Exposer | Implemented |
| V2-CAP-010 | Execution Runtime | Common tool execution lifecycle | Execution Runtime | Implemented |
| V2-CAP-011 | Permission Broker | Central permission decision before execution | Permission Broker | Implemented |
| V2-CAP-012 | Approval | Human approval for gated operations | Tool/Shell Approval | Implemented |
| V2-CAP-013 | Audit | Persistent execution metadata | Audit Store | Implemented |
| V2-CAP-014 | Recovery | Failed/interrupted execution inspection | recovery_status | Implemented |
| V2-CAP-015 | Filesystem Tools | Workspace read/write/list/exact patch | fs_* / apply_patch | Implemented |
| V2-CAP-016 | Git Tools | Local Git operations and controlled push | git_* | Implemented |
| V2-CAP-017 | Platform Validation | Allowlisted P05 platform validation actions | command_run | Implemented |
| V2-CAP-018 | Shell | Workspace-aware PowerShell execution | shell_run | Implemented |
| V2-CAP-019 | Runtime Lifecycle | Restart current Runtime Slot | runtime_restart | Implemented |
| V2-CAP-020 | Plugin Framework | Plugin registry/lifecycle/permissions/capabilities | Plugin API v1 | Implemented |
| V2-CAP-021 | Plugin Runtime | Plugin start/stop/state/failure isolation | PluginRuntime | Implemented |
| V2-CAP-022 | Downstream MCP | External MCP registry/discovery/call | Downstream Registry | Implemented |
| V2-CAP-023 | MATLAB Plugin | MATLAB/Simulink integration through Plugin | MATLAB Plugin 2.2.0 | Implemented |
| V2-CAP-024 | MATLAB Skills | MATLAB Skill Catalog query/read | matlab.skill_* | Implemented |
| V2-CAP-025 | Local Operator | Local human control plane | P05-Operator.cmd | Implemented |
| V2-CAP-026 | HTTP Reviewer | Native readonly Streamable HTTP MCP endpoint | HTTP Reviewer | Implemented |
| V2-CAP-027 | Reviewer OAuth | External Reviewer authentication | OAuth Code + PKCE | Implemented |
| V2-CAP-028 | Public HTTPS Test Entry | Temporary cloud access to Reviewer | Cloudflare Quick Tunnel | Implemented / test-grade |
| V2-CAP-029 | MCP ToolAnnotations | Tool hints generated from capability metadata | Capability -> ToolAnnotations | Implemented |
| V2-CAP-030 | Bootstrap | Repo-local initialization | bootstrap.ps1 | Implemented |
| V2-CAP-031 | Deployment | Runtime A/B scripts, profiles, health and preflight | scripts/deployment | Implemented |
| V2-CAP-032 | Verification | Automated compile/policy/plugin/reviewer regression | npm test / verify | Implemented |

## 3. Runtime and connection assets

V2 currently provides two independent Runtime Slots:

    ChatGPT Chat A
        -> Tunnel A
        -> Runtime A
        -> Workspace A

    ChatGPT Chat B
        -> Tunnel B
        -> Runtime B
        -> Workspace B

Each Runtime Slot has independent:

- tunnel profile;
- Runtime state directory;
- Workspace binding;
- Reference Roots;
- Plugin runtime state;
- Downstream state;
- Audit / Recovery state.

V2 supports:

- A/B concurrent operation;
- independent Runtime start;
- independent Runtime stop;
- independent Runtime restart;
- independent Workspace binding;
- Runtime health endpoints;
- Runtime-slot attribution in Audit.

## 4. Workspace assets

V2 Workspace capabilities include:

- Workspace Registry;
- stable logical Workspace ID;
- Workspace kinds: platform-source / git-project / generic;
- one active Workspace per Runtime;
- exactly one platform-source Workspace;
- Runtime-local Workspace persistence;
- structured tool Workspace boundary;
- cross-Workspace structured access denial;
- Workspace Plugin allowlist;
- remote Workspace query;
- Local Operator Workspace binding.

Remote MCP clients do not own Workspace authorization.

## 5. Reference Root assets

Each Runtime supports:

    1 Active Workspace
    +
    N Reference Roots

Reference Roots are:

- Runtime-scoped;
- persistent across Runtime restart;
- authorized through Local Operator;
- read/list only;
- not writable;
- not Git execution roots;
- not Shell execution roots;
- not MATLAB execution roots.

Remote interfaces:

- reference_list;
- reference_read;
- reference_list_directory.

## 6. Capability and profile assets

V2 has a unified Capability Catalog.

Each capability declares metadata equivalent to:

- name;
- minimum Tool Profile;
- risk;
- scope;
- summary.

Implemented Tool Profiles:

| Profile | V2 Capability Level |
| --- | --- |
| discovery | device identity / liveness |
| readonly | Workspace/Reference/Audit/Recovery/read-only file and Git/plugin query |
| developer | readonly + Workspace mutation/local Git/platform validation/Runtime lifecycle/gated Shell |
| full | developer + Git push + generic downstream execution |

Unknown profiles fail closed.

Suppressed tools are not advertised.

## 7. Core tool surface

### Discovery

- device_info
- ping

### Workspace / control

- workspace_list
- workspace_current
- activity_recent
- recovery_status
- plugin_list

### Reference

- reference_list
- reference_read
- reference_list_directory

### Filesystem

- fs_read
- fs_list
- fs_write
- apply_patch

### Git

- git_status
- git_diff
- git_diff_stat
- git_add
- git_commit
- git_branch
- git_push

### Execution / lifecycle

- command_run
- runtime_restart
- shell_run

### Downstream MCP

- mcp_status
- mcp_list_tools
- mcp_call_tool

## 8. Filesystem assets

V2 implements Workspace-bounded filesystem operations:

- UTF-8 read;
- directory listing;
- create/replace text file;
- exact text patch.

apply_patch includes:

- expected SHA-256 precondition;
- exact old_text matching.

This protects against accidental overwrite after concurrent changes.

## 9. Git assets

Implemented Git operations:

- status;
- staged/unstaged diff;
- diff stat;
- add explicit paths;
- local commit;
- create/switch/safe-delete branch;
- controlled push.

Current constraints include:

- git_add accepts explicit paths;
- Git pathspec magic is refused;
- branch force delete is not exposed;
- Git push does not expose force;
- Git push does not expose arbitrary refspec;
- Git push requires full profile.

## 10. Platform validation and self-development assets

command_run provides allowlisted P05 platform validation actions.

Platform validation is bound to platform-source and does not follow the active business Workspace.

The current V2 self-development loop can perform:

    read
    -> inspect
    -> patch/write
    -> check
    -> build
    -> verify
    -> diff
    -> optional local commit
    -> Runtime restart
    -> reconnect
    -> verify

## 11. Shell and approval assets

shell_run executes PowerShell through the V2 permission boundary.

Current V2 behavior includes:

- active Workspace as default cwd;
- path accessibility checks;
- Permission Broker evaluation;
- automatic execution only for a narrow provable-safe path;
- Local Operator confirmation for calls that cannot be proven safe;
- explicit denial where required.

Approval is bound to:

- Runtime Slot;
- Workspace;
- cwd;
- exact command.

Approval is:

- time-limited;
- single-use;
- not self-approvable by the Runtime.

Operator displays command purpose and approval reason.

V2 shell gating is not an OS sandbox.

## 12. Permission and approval assets

Implemented modules include:

- policy/permission-broker;
- policy/permission;
- approval/tool-approval;
- approval/shell-approval.

Execution follows the logical flow:

    Tool Call
        -> Capability
        -> Permission Broker
        -> allow / approval_required / deny
        -> Execution

## 13. Execution Runtime assets

Exposed tools use a common execution lifecycle:

    prepare
        -> authorize
        -> execute
        -> verify
        -> complete

Failures are classified and assigned recovery metadata.

The runtime records execution phase/state and supports interrupted-run recovery semantics.

## 14. Audit and recovery assets

Audit stores bounded execution metadata such as:

- execution ID;
- capability;
- scope;
- Workspace ID;
- source;
- transport;
- Runtime Slot;
- principal when available;
- MCP client name/version when available;
- state;
- phase;
- timestamps;
- duration;
- error category;
- recovery hint.

Audit deliberately avoids storing:

- raw file contents;
- secret values;
- raw secret-bearing downstream arguments.

Query interfaces:

- activity_recent;
- recovery_status.

A/B Audit state is independent.

## 15. Plugin Framework assets

V2 Plugin API v1 supports:

- stable Plugin ID;
- Plugin version;
- Plugin API version;
- Plugin Catalog;
- Plugin Manifest;
- enabled state;
- permissions declaration;
- dependency metadata;
- capability contribution;
- downstream contribution;
- Workspace-aware activation;
- Workspace Plugin allowlist;
- Plugin-owned Downstream;
- Plugin failure isolation;
- Runtime A/B independent Plugin state;
- Plugin start/stop through Local Operator;
- downstream cleanup on Plugin stop;
- downstream lazy connect.

Current Plugin states include:

- disabled;
- ready;
- running;
- failed;
- stopped.

Plugin initialization failure is contained as Plugin-local failure and does not intentionally terminate Core startup.

V2 does not support remote arbitrary-path Plugin loading.

## 16. MATLAB / Simulink Plugin assets

Current reference Application Plugin:

    id: matlab
    version: 2.2.0
    apiVersion: 1

Current capabilities:

- matlab.call_tool;
- matlab.skill_list;
- matlab.skill_read.

Implemented behavior includes:

- MathWorks MCP downstream;
- MATLAB tool discovery;
- MATLAB Skill Catalog;
- Workspace-aware activation;
- Workspace path binding;
- MATLAB working-directory synchronization;
- lazy downstream connection;
- Runtime A/B independent state;
- Operator Plugin Start / Stop;
- Plugin-owned downstream.

## 17. Downstream MCP assets

V2 Downstream Registry supports:

- server definitions;
- connection state;
- tool discovery;
- generic tool invocation;
- Plugin ownership;
- Workspace binding;
- lazy connection.

Interfaces:

- mcp_status;
- mcp_list_tools;
- mcp_call_tool.

## 18. Local Operator assets

P05 provides a local Operator Console:

    P05-Operator.cmd
        -> http://127.0.0.1:56301/

The Operator is loopback-only.

Current Operator capabilities include:

- Runtime A/B Start / Stop / Restart;
- Workspace selection/binding;
- Reference Root Add / Remove;
- Plugin Start / Stop;
- Downstream status;
- Git status;
- Runtime health;
- Activity;
- Live Activity;
- Recovery;
- Tunnel logs.

Operator is the local Human Control Plane and has authority that remote MCP clients do not have.

## 19. Native HTTP Reviewer assets

V2 includes an independent native Streamable HTTP MCP Reviewer.

Default endpoint:

    http://127.0.0.1:8765/mcp

Health endpoint:

    /healthz

Current behavior:

- bind to Runtime Slot;
- default Slot B;
- readonly profile;
- follows selected Runtime Workspace state;
- does not require restart after Runtime Workspace rebinding;
- cannot switch Workspace;
- cannot write;
- cannot execute Shell.

Current Reviewer surface includes:

- device_info;
- ping;
- workspace_list;
- workspace_current;
- review_context;
- fs_read;
- fs_list;
- git_status;
- git_diff;
- git_diff_stat;
- reference_list;
- reference_read;
- reference_list_directory.

Write/execute/developer/full operations are intentionally absent from the Reviewer surface.

## 20. Reviewer fresh-context asset

review_context refreshes current Reviewer context including:

- Runtime;
- active Workspace;
- Git state;
- Reference Roots;
- Reviewer authority boundary;
- timestamp.

This avoids treating stale conversation context as current machine truth.

## 21. Reviewer OAuth assets

V2 Reviewer OAuth includes:

- OAuth Protected Resource Metadata;
- Authorization Server Metadata;
- Authorization Code;
- PKCE S256;
- Access Token;
- Refresh Token;
- client_secret_basic;
- client_secret_post.

Token state is stored as hash + expiry in Runtime-local state.

Current Reviewer scope:

    p05.review

This scope does not grant developer/full, Workspace rebind, Reference authorization, Shell or MATLAB execution.

## 22. Public HTTPS test asset

Development deployments can expose the local HTTP Reviewer through Cloudflare Quick Tunnel.

Characteristics:

- HTTPS;
- suitable for cloud-client integration tests;
- temporary URL;
- repo-local cloudflared binary;
- not a production deployment contract.

## 23. External MCP client validation assets

V2 has been validated with:

- ChatGPT;
- Gemini;
- standard MCP SDK Client.

A real external-review flow has been exercised against a project Workspace using Git/file review operations.

## 24. MCP ToolAnnotations asset

ToolAnnotations are generated from Capability metadata rather than maintained independently per tool.

For readonly tools, generated hints include values equivalent to:

- readOnlyHint=true;
- destructiveHint=false;
- idempotentHint=true;
- openWorldHint=false.

Annotations are client hints only; enforcement remains in P05 Policy.

## 25. Deployment and bootstrap assets

V2 provides repo-local deployment/bootstrap infrastructure.

Primary assets include:

- bootstrap.ps1;
- scripts/deployment/*;
- repo-local Node;
- repo-local tunnel-client;
- repo-local cloudflared;
- .p05 machine-local state;
- Runtime profiles;
- Runtime state directories;
- preflight and network checks.

Machine-local state and secrets are Git-ignored.

## 26. Deployment script assets

Current deployment scripts include capabilities equivalent to:

- run Runtime Slot;
- stop Runtime Slot;
- restart Runtime Slot;
- request delayed Runtime restart;
- generate Runtime profiles;
- preflight;
- network diagnostics;
- run/open Operator.

A/B can be managed independently.

## 27. Verification assets

Current package verification includes:

- TypeScript check/build;
- policy profile tests;
- exposure tests;
- foundation tests;
- Git mutation tests;
- Operator tests;
- output schema tests;
- Plugin framework tests;
- Plugin API v1 tests;
- downstream smoke tests;
- HTTP Reviewer tests;
- MATLAB live tests.

Recorded regression coverage includes:

- A/B Runtime independence;
- A/B Workspace independence;
- Workspace restart persistence;
- multiple Reference Roots;
- Plugin Start / Stop;
- MATLAB lazy connect;
- MATLAB Workspace binding;
- Streamable HTTP MCP;
- readonly Reviewer surface;
- OAuth Authorization Code + PKCE;
- Refresh Token;
- public HTTPS test path;
- Gemini Connected App;
- MCP ToolAnnotations.

## 28. Current V2 capability boundary

The implemented V2 capability baseline can be summarized as:

    P05 V2
    |
    +-- MCP Connectivity
    |   +-- Tunnel A
    |   +-- Tunnel B
    |   +-- Streamable HTTP Reviewer
    |
    +-- Runtime
    |   +-- Slot A
    |   +-- Slot B
    |
    +-- Workspace
    |   +-- Active Workspace
    |   +-- Reference Roots
    |
    +-- Security / Control
    |   +-- Capability Catalog
    |   +-- Tool Profiles
    |   +-- Permission Broker
    |   +-- Approval
    |   +-- Workspace Boundary
    |   +-- Shell Approval Gate
    |
    +-- Execution
    |   +-- Filesystem
    |   +-- Git
    |   +-- Shell
    |   +-- Platform Validation
    |   +-- Runtime Lifecycle
    |
    +-- Audit / Recovery
    |
    +-- Plugin Framework
    |   +-- Plugin Registry
    |   +-- Plugin Runtime
    |   +-- Workspace Activation
    |   +-- Plugin-owned Downstream
    |
    +-- Application Plugin
    |   +-- MATLAB / Simulink
    |
    +-- Downstream MCP
    |
    +-- Local Operator
    |
    +-- External Reviewer
    |   +-- readonly MCP
    |   +-- OAuth
    |   +-- Public HTTPS test entry
    |
    +-- Deployment / Verification

## 29. Baseline conclusion

P05 V2 already contains a substantial local engineering Agent Platform capability base:

- multiple independent Runtime Slots;
- Workspace and Reference authorization;
- Capability / Permission / Approval control;
- common execution lifecycle;
- File / Git / Shell operations;
- Audit / Recovery;
- Plugin Framework;
- Downstream MCP;
- MATLAB / Simulink integration;
- Local Operator;
- external readonly HTTP Reviewer;
- OAuth;
- deployment and verification infrastructure.

These are recorded as V2 capability assets and should be used as factual input to later V3 architecture work.
