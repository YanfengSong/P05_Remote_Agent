# ADR-0020 — V2 Common Tool Permission Broker

Status: Accepted
Date: 2026-09-23
Scope: Foundation V2 permission subsystem only

## Context

P05 previously introduced a Shell-specific approval gate to prevent unrestricted
PowerShell from bypassing the active Workspace boundary.

The execution-surface review showed that Shell is not the only capability that can
create host, downstream or external effects. Examples include:

- `command_run`;
- `runtime_restart`;
- `git_push`;
- generic downstream `mcp_call_tool`;
- `matlab.call_tool` subtools such as `evaluate_matlab_code` and `model_edit`.

Building a separate gate for every execution surface would duplicate policy and
would move P05 toward a custom security framework.

Mature agent implementations instead separate:

- capability/profile exposure;
- per-tool allow / confirm / deny policy;
- structured Workspace guards;
- stronger sandbox/runtime isolation when arbitrary code must auto-run.

## Decision

Foundation V2 uses one common Tool Permission Broker.

The Broker returns one of:

- **ALLOW** — execute immediately;
- **CONFIRM** — create a Runtime-private one-time approval request and wait for
  Local Operator approval;
- **DENY** — refuse the operation.

This is a refactor of the permission subsystem only. It does not redesign Runtime
A/B, Workspace, Reference Roots, Plugin Framework, Downstream Registry, Deployment,
Audit/Recovery or HTTP Reviewer.

## Integration boundary

All normal MCP tool registrations continue through the existing `Exposer`.

The `Exposer` applies:

1. Tool Profile exposure check;
2. common Tool Permission Broker;
3. existing Execution Runtime lifecycle;
4. existing tool handler.

Plugin tools therefore receive the same permission decision path without changing
the Plugin architecture.

`shell_run` uses the same Broker path as every other exposed tool. A CONFIRM
decision is surfaced through the common permission envelope and the common Tool
Approval store; Shell no longer owns a separate approval response or persistence
model.

## V2 default policy

| Capability class | V2 default |
|---|---|
| Structured read-only operations | ALLOW |
| Structured Workspace-local file/Git mutation | ALLOW |
| Small recognized Workspace-local Shell allowlist | ALLOW |
| Arbitrary / ambiguous Shell | CONFIRM |
| Catastrophic disk/root destructive Shell patterns | DENY |
| `command_run` repository validation | CONFIRM |
| `runtime_restart` | CONFIRM |
| `git_push` | CONFIRM |
| generic `mcp_call_tool` | CONFIRM |
| MATLAB/Simulink known read-only subtools | ALLOW |
| MATLAB/Simulink mutation / code execution subtools | CONFIRM |

Tool Profile remains the maximum authority ceiling. A CONFIRM decision cannot
expose a tool that the active profile does not already expose.

## Approval semantics

A confirmation request is bound to:

- Runtime slot;
- active Workspace id and root;
- capability identity;
- operation identity;
- exact canonicalized tool arguments.

The request:

- expires after 15 minutes;
- is approved/denied only through Local Operator;
- is consumed before one execution;
- cannot be reused;
- does not authorize a changed tool call.

The approval record stores only a sanitized input summary for Operator display.
The exact arguments participate in the SHA-256 fingerprint but are not persisted
as raw approval content.

The canonical public approval fields are:

- `approvalId`;
- Runtime `slot`;
- `workspaceId`;
- `capability`;
- `operation`;
- optional sanitized `inputSummary`;
- `purpose`;
- `reason`.

Operator list/decision responses add `status`, `requestedAt` and `expiresAt`.

## Operator UX

Pending approvals show:

- Runtime;
- Workspace;
- Tool;
- Operation;
- plain-language purpose;
- reason confirmation is required;
- sanitized call summary;
- request and expiry times.

This is intentionally human-readable because the local user should not need to
understand raw Shell/MCP syntax to make a permission decision.

## Shell policy after ADR-0020

The Shell policy is no longer intended to become a general PowerShell semantic
analyzer.

It remains a small policy adapter that provides:

- a small diagnostic/read allowlist;
- a small set of explicit Workspace-local file operations;
- conservative Git read recognition;
- catastrophic deny checks;
- CONFIRM for everything else.

Unknown or complex Shell syntax is not automatically trusted.

## V3 boundary

The following are NOT implemented by this V2 ADR and remain V3 requirements:

- OS-level Workspace-write Sandbox;
- unified hard execution boundary;
- trusted/immutable build-test-restart runner;
- isolated Plugin/Downstream runtimes;
- network sandbox/policy;
- persistent permission-rule hierarchy;
- Permission Broker as an independent V3 Service/Component;
- Trust Kernel isolation from ordinary self-modification.

V2 does not pretend that allow/confirm/deny is an OS sandbox.

## Consequences

Positive:

- one permission model covers Core, Plugin and Downstream execution surfaces;
- Shell-specific approval persistence is no longer a separate subsystem;
- Workspace/Reference architecture remains unchanged;
- Operator has one approval queue;
- future tools can reuse the same permission path;
- V2 remains a bounded refactor instead of an architecture rewrite.

Limitations:

- arbitrary code approved by a user still executes with the Runtime process OS
  authority;
- `command_run` and `runtime_restart` remain confirmation-gated until V3 can
  provide an immutable runner or stronger isolation;
- persistent user-defined allow/confirm/deny rules are deferred to V3.

## Verification

Final V2 permission regression and live acceptance:

- ACTION verify — PASS (Runtime B audit completed `state=succeeded`; caller response window expired after ~67.8 s);
- ACTION build — PASS;
- POLICY_PROFILES_OK — 264 checks;
- PROFILE_EXPOSURE_OK — 195 checks;
- PLUGIN_FRAMEWORK_OK — 35 checks;
- OUTPUT_SCHEMA_OK — 176 checks;
- OPERATOR_CONSOLE_OK — 68 checks;
- Runtime B live one-shot Tool Approval — PASS;
- Runtime A live one-shot Tool Approval — PASS.

Both live Runtime checks proved the same sequence: CONFIRM before execution, Local
Operator one-time approval, exact retry executes, approval is consumed before
execution, and a subsequent identical call creates a new approval request.

## Supersedes / relates

- ADR-0008 — Developer Shell Trust Model: retired;
- ADR-0019 — Workspace-Aware Shell Approval Gate: Shell-specific approval
  architecture superseded by this common Broker; its one-shot approval and
  Workspace safety requirements are retained.
