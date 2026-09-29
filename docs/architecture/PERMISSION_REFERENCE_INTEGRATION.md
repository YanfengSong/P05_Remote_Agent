# P05 Permission Architecture — Reference-First Integration Plan

Status: ACCEPTED FOR V2 PERMISSION SUBSYSTEM
Date: 2026-09-23
Branch: feature/shell-approval-gate

Scope boundary: this document governs the V2 permission-management subsystem only.
It does not authorize a redesign of Runtime A/B, Workspace, Plugin Framework,
Execution Runtime, deployment or the wider P05 architecture. Any reference solution
that requires those architectural changes is recorded as a V3 requirement instead.

## 1. Goal

P05 is a mature-solution integration project, not a project for inventing a new agent security model.

For every new execution, permission, sandbox, plugin, deployment or workflow capability:

1. inspect current mature open-source / official implementations first;
2. extract their proven control model;
3. integrate the smallest compatible mechanism into P05;
4. add P05-specific code only for gaps such as Runtime A/B, Windows local operation, Workspace/Reference binding and Local Operator UX.

Security mechanisms MUST NOT depend on prompt instructions alone.

## 2. Reference implementations

### OpenAI Codex

Reference:
- https://github.com/openai/codex
- https://developers.openai.com/zh-Hans/docs/config-file/config-basic
- https://learn.chatgpt.com/docs/changelog

Useful pattern:
- separate sandbox authority from approval policy;
- reusable permission profiles such as read-only / workspace / danger-full-access;
- workspace-write constrains filesystem/network authority;
- approval is used when work crosses the granted sandbox boundary;
- command rules are supplementary controls, not a replacement for the sandbox;
- current Windows Codex uses a native Windows sandbox rather than relying only on command parsing.

P05 adoption:
- keep Workspace as the logical authority scope;
- stop treating PowerShell semantic parsing as the primary security boundary;
- keep approval as a boundary-crossing mechanism;
- evaluate an existing Windows sandbox/runtime as a later hard-confinement layer instead of building a custom PowerShell sandbox.

### Zed

Reference:
- https://github.com/zed-industries/zed/blob/main/docs/src/ai/tool-permissions.md
- https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md

Useful pattern:
- common tool permission states: allow / confirm / deny;
- global default plus per-tool policy;
- terminal rules can use small allow/confirm/deny patterns;
- MCP tools use the same permission framework with stable identities such as mcp:<server>:<tool>;
- small built-in non-overridable destructive-command blocks protect critical deletion cases;
- UI supports one-time approval and persistent policy choices.

P05 adoption:
- use one common Tool Permission Broker;
- use stable identities for core tools and downstream MCP subtools;
- retain a very small hard deny layer for catastrophic operations;
- do not grow a general PowerShell parser.

### Cline

Reference:
- https://github.com/cline/cline/blob/main/docs/sdk/guides/permission-handling.mdx
- https://github.com/cline/cline/blob/main/docs/sdk/tools.mdx

Useful pattern:
- per-tool policy: autoApprove true / autoApprove false / enabled false;
- read/search can auto-run while write/command tools can require approval;
- approval handler receives tool name and tool input;
- conditional approval can be added for narrowly understood cases;
- full auto-approval is intended only for trusted or sandboxed environments.

P05 adoption:
- Tool Profile remains the maximum capability ceiling;
- the Permission Broker decides allow / confirm / deny at call time;
- Local Operator remains the human approval handler;
- approval UI must show tool identity, plain-language purpose, important targets and raw input.

### OpenHands

Reference:
- https://github.com/OpenHands/docs/blob/main/llms.txt
- https://docs.openhands.dev/openhands/usage/sandboxes/overview
- https://docs.openhands.dev/openhands/usage/sandboxes/docker

Useful pattern:
- arbitrary code execution belongs in an explicit sandbox/runtime;
- writable project data and read-only reference data are mounted with different authority;
- stronger isolation is a runtime concern rather than a command-understanding problem.

P05 adoption:
- retain the Workspace / Reference Root distinction;
- future arbitrary-code auto-execution should happen only behind a mature sandbox boundary;
- host-bound integrations that cannot be sandboxed remain confirmation-gated.

### Model Context Protocol

Reference:
- https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices
- https://tasks.extensions.modelcontextprotocol.io/

Useful pattern:
- preserve explicit trust boundaries and minimize granted scope;
- do not allow proxy/downstream paths to bypass controls;
- durable human-in-the-loop operations are a recognized MCP use case;
- consent/authorization must bind to the actual client, scope and operation rather than broad implicit trust.

P05 adoption:
- Downstream MCP calls must not become an ungoverned bypass;
- broker decisions bind to Runtime, Workspace, tool identity and relevant arguments;
- approval remains one operation unless the user explicitly creates a persistent policy.

## 3. P05 target permission model

P05 should use four layers, each with a narrow job:

    Tool Profile
        ↓ maximum capability ceiling
    Tool Permission Broker
        ↓ allow / confirm / deny
    Workspace / Reference structured guards
        ↓ explicit path authority for structured tools
    Optional OS Sandbox / isolated Runtime
        ↓ hard confinement for arbitrary code

The layers MUST NOT duplicate each other's job.

### Tool Profile

Keep:
- discovery;
- readonly;
- developer;
- full.

Purpose:
- controls which capabilities may exist for a session;
- does not mean every exposed capability automatically executes.

### Tool Permission Broker

Decision:
- ALLOW — execute immediately;
- CONFIRM — Local Operator approval required;
- DENY — operation is unavailable.

Minimum decision inputs:
- Runtime slot;
- active Workspace;
- capability/tool identity;
- effect class;
- relevant target/resource identity;
- configured policy.

The Broker must be common to Core tools, Plugin tools and Downstream MCP tools.

### Structured Workspace guards

Keep for:
- fs_read / fs_list;
- fs_write / apply_patch;
- structured Git operations;
- Reference Roots.

These tools already expose explicit paths and operations, so direct boundary validation is appropriate.

Do not replace explicit structured checks with shell parsing.

### Sandbox / isolated Runtime

Use only when P05 needs arbitrary code to auto-run without per-call confirmation.

P05 should integrate an existing sandbox mechanism rather than implementing a general PowerShell/MATLAB semantic sandbox.

## 4. Current P05 mapping

| Current surface | Current behavior | Reference-aligned target | Decision |
|---|---|---|---|
| fs_read / fs_list | Workspace path guard | structured guard + ALLOW | KEEP |
| reference_read/list | explicit read-only roots | read-only authority | KEEP |
| fs_write / apply_patch | Workspace path guard | structured guard + ALLOW | KEEP, harden implementation details |
| git status/diff | structured read | ALLOW | KEEP |
| git add/commit/branch | bounded local mutation | ALLOW inside Workspace | KEEP |
| git_push | full-only external mutation | CONFIRM | CHANGE |
| shell_run | growing static PowerShell classifier | terminal default CONFIRM; small allow rules; small hard deny rules; sandbox later | SIMPLIFY |
| Tool Approval record/UI | one-shot Local Operator approval | common Broker approval | KEEP / GENERALIZED |
| command_run | allowlisted action executes mutable repo code | CONFIRM until executed in a hard sandbox or trusted immutable runner | CHANGE |
| runtime_restart | fixed entry invokes writable repo scripts | CONFIRM or move trusted controller outside writable Workspace | CHANGE |
| matlab.call_tool | developer can call arbitrary downstream MATLAB tool | per downstream-tool policy; read tools ALLOW, code/edit tools CONFIRM | CHANGE |
| mcp_call_tool | generic full-profile downstream execution | per MCP tool allow/confirm/deny | CHANGE |
| HTTP Reviewer | fixed readonly surface | readonly isolated review surface | KEEP |
| destructive shell blocklist | defense-in-depth | tiny non-overridable DENY set | KEEP SMALL |

## 5. Default policy proposal

| Effect | Example | Default |
|---|---|---|
| Read-only structured | fs_read, git_status, model_read | ALLOW |
| Workspace-local structured mutation | fs_write, apply_patch, git_add | ALLOW |
| Known fixed validation with immutable/sandboxed runner | build/test/verify | ALLOW |
| Arbitrary shell/code execution without sandbox | shell_run, evaluate_matlab_code | CONFIRM |
| Downstream mutation | model_edit, write-capable MCP tool | CONFIRM |
| External mutation | git_push, publish, remote create/update | CONFIRM |
| Host lifecycle | runtime_restart | CONFIRM unless backed by trusted immutable broker |
| Catastrophic/system-wide operation | root-drive recursive delete, security-control tampering | DENY |

A later sandbox can change an arbitrary-code operation from CONFIRM to ALLOW only when the sandbox itself provides the required boundary.

## 6. What to remove from the current direction

Do not continue expanding the Shell V1 classifier into:
- a full PowerShell grammar;
- Git semantic emulation;
- child-interpreter analysis;
- MATLAB code analysis;
- generic arbitrary-code effect prediction.

The current classifier can remain temporarily as:
- a small convenience allowlist;
- a small catastrophic deny layer;
- an approval trigger.

It is not the long-term security boundary.

## 7. What to retain from the current branch

Retain:
- Runtime-specific approval ownership;
- exact one-time approval;
- expiry and consume-before-execute semantics;
- Local Operator approve/deny UI;
- plain-language purpose and approval reason;
- Workspace and Reference Root model;
- structured path guards;
- audit/recovery metadata;
- fail-closed behavior when Runtime identity is missing.

Generalize these into the common Tool Permission Broker rather than deleting them.

## 8. Integration order

Phase 1 — V2 permission integration — COMPLETE:
1. Shell parser growth frozen;
2. common ALLOW / CONFIRM / DENY vocabulary implemented;
3. Shell uses the common Tool Permission Broker;
4. Shell-specific approval persistence removed and tests migrated.

Phase 2 — V2 alternate-path closure — COMPLETE:
1. matlab.call_tool uses downstream subtool policy;
2. mcp_call_tool uses the same Broker;
3. git_push is external CONFIRM;
4. command_run/runtime_restart are CONFIRM in V2.

Phase 3 — V3 requirements only (not implemented in V2):
1. compare Codex native Windows sandbox, container-based execution and other maintained Windows-capable sandboxes;
2. prototype without changing P05 authorization semantics;
3. only adopt if it reduces approval friction without weakening Workspace isolation.

## 9. Reference-First development rule

Before implementing a new P05 capability, the design note SHOULD record:

| Item | Required question |
|---|---|
| Problem | What capability are we adding? |
| References | Which maintained projects already solve it? |
| Adopt | Which proven mechanism are we reusing? |
| Adapt | What P05-specific adaptation is necessary? |
| Reject | Which reference mechanisms do not fit, and why? |
| Verification | How will we prove the integration preserves P05 boundaries? |

For security-sensitive capabilities, use at least two independent mature references when practical.

If a mature mechanism exists, P05 SHOULD integrate or adapt it rather than create a parallel custom subsystem.

## 10. Current decision for feature/shell-approval-gate

The common V2 Tool Permission Broker is now the permission entry point. Do not grow the Shell classifier into a separate authorization system.

The current branch is treated as a useful prototype whose reusable assets are:
- approval persistence;
- Runtime binding;
- Local Operator workflow;
- purpose explanation;
- tests for one-shot approval and boundary failures.

ADR-0019 is superseded by ADR-0020. Shell is one consumer of the common Tool Permission Broker and no longer owns an independent approval architecture.
