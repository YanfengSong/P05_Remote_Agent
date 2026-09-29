# P05 Permission and Self-Development Model

Updated: 2026-09-23
Foundation: V2

## Core rule

**Self-development is allowed; self-authorization is not.**

## Authority layers

### 1. Tool profile

- discovery: identity/health;
- readonly: Workspace/control inspection and bounded read operations;
- developer: Workspace mutation, local Git mutation, permission-gated platform validation/restart, downstream discovery and brokered `shell_run`;
- full: developer + external Git push and generic downstream execution.

Unknown profiles fail closed and suppressed tools are not advertised.

### 2. Host allowed roots

`REMOTE_AGENT_ALLOWED_ROOTS` is the outer structured-tool host perimeter.

There is no built-in machine path.

### 3. Registered Workspace boundary

Allowed roots and active Workspace are different concepts.

A Workspace is a registered canonical root plus authorization semantics.

Structured Workspace tools are confined to the active Workspace. An absolute path into another Workspace is refused even when both Workspaces are inside the global allowed roots.

Workspace switching accepts a registered id only.

Exactly one Workspace is `platform-source`.

### 4. Platform authority

P05 platform self-validation is not a business-Workspace operation.

`command_run` always executes against the platform-source root.

Switching to P02 or another business Workspace cannot redirect P05 build/test/verify.

### 5. Execution Runtime

Every exposed tool runs through the common lifecycle:

    prepare -> authorize -> execute -> verify -> complete

Failures are classified for audit/recovery.

### 6. Persistent audit / recovery

Audit stores metadata only and is persisted in protected P05 state.

It does not retain raw command text, file content or raw arguments.

An execution left running across restart is marked interrupted.

### 7. Runtime lifecycle and host authority

`runtime_restart` is a narrow Runtime lifecycle operation. It resolves the
current Runtime slot and invokes the fixed repo-local
`scripts/deployment/request-restart-runtime-slot.ps1` path, which schedules a
delayed detached restart of that slot only.

It is not a generic host command broker and it accepts no caller-supplied
command, path, task name, credential or elevation parameter.

The historical `P05-RestartBroker` Scheduled Task is retired and is not
required by the normal Runtime path.

Broader host/system mutation (services, firewall, registry, system packages,
privileged configuration) remains outside ordinary structured developer
authority and continues to require explicit approval, an external broker, or a
stronger OS execution boundary as appropriate.

## Operation classes

Foundation V2 separates profile exposure from call-time permission. The Tool Profile determines whether a capability may be exposed at all; the common Tool Permission Broker then returns ALLOW / CONFIRM / DENY for the concrete call.

| Class | Examples | V2 call-time policy |
|---|---|---|
| Observe | fs_read, fs_list, git_status, activity_recent | ALLOW |
| Workspace mutate | fs_write, apply_patch, git_add, git_commit, git_branch | ALLOW through existing structured Workspace guard |
| Platform execute | command_run(check/build/verify) | CONFIRM |
| Shell | shell_run | small Workspace-safe allowlist; otherwise CONFIRM; catastrophic patterns DENY |
| Runtime lifecycle | runtime_restart | CONFIRM |
| External remote mutate | git_push | CONFIRM when exposed by full profile |
| Generic downstream execute | mcp_call_tool | CONFIRM when exposed by full profile |
| MATLAB/Simulink downstream | matlab.call_tool | known read-only subtools ALLOW; mutation/code execution CONFIRM |
| Host/system mutate | services, firewall, registry, system packages | DENY or explicit broker; not ordinary V2 developer authority |

## Git rules

`git_add`:
- explicit paths only;
- active-Workspace boundary;
- Git pathspec magic refused.

`git_commit`:
- local commit;
- bounded nonblank message.

`git_branch`:
- create;
- switch;
- safe delete;
- no force delete.

`git_push`:
- full profile;
- named remote;
- current HEAD;
- no force;
- no arbitrary refspec.

## Common Tool Permission boundary

All normal Core and Plugin tool registrations pass through the V2 common Tool Permission Broker defined by ADR-0020.

The Broker evaluates the concrete call as ALLOW / CONFIRM / DENY after Tool Profile exposure has already succeeded. CONFIRM creates a Runtime-private Local Operator request bound to Runtime slot, active Workspace, capability, operation and exact canonicalized arguments. Approval expires after 15 minutes and is consumed before one execution.

`shell_run` is one consumer of this common Broker. Its policy adapter intentionally remains small: recognized Workspace-safe reads and a small set of explicit Workspace-local file operations may auto-run; complex, arbitrary or external execution requires CONFIRM; catastrophic disk/root destructive patterns are DENY. Shell parsing is not treated as a general sandbox.

`command_run`, `runtime_restart`, `git_push`, generic `mcp_call_tool`, and mutating/arbitrary-code MATLAB downstream tools are confirmation-gated in V2. Known MATLAB/Simulink read-only subtools are allowed directly.

Structured Workspace tools keep their existing path guards. The Permission Broker does not replace Workspace/Reference authorization.

OS-level Sandbox, immutable runner and unified hard execution boundary remain V3 requirements.

## Plugin permissions

Application plugins declare permissions and may be limited per Workspace.

Downstream MCP definitions carry plugin ownership and Workspace-binding semantics.

The Downstream Registry refuses plugin-owned downstreams when that plugin is unavailable for the active Workspace.

## Self-development loop

Accepted loop:

    read
    -> inspect
    -> patch/write
    -> check
    -> build
    -> verify
    -> diff
    -> optional local commit
    -> runtime_restart
    -> reconnect
    -> verify

Remote push remains a separate elevated action.

## Related decisions

- ADR-0007: External Restart Broker (Retired / Superseded by repo-local slot restart)
- ADR-0008: Developer Shell Trust Model (retired)
- ADR-0019: Workspace-Aware Shell Approval Gate (superseded by common V2 Broker; Shell safety requirements retained)
- ADR-0020: V2 Common Tool Permission Broker
- ADR-0009: Foundation V1
- ADR-0010: Foundation V2
- ADR-0011: Core / Plugin Framework Boundary

## Architecture V3 composition boundary

Architecture V3 introduces a dynamic Context/Component Runtime, but it does not replace this permission model.

### Context visibility is not authority

A V3 Context may make a Service/Capability implementation visible to a Component or Agent scope.

That means only:

> an implementation is compositionally reachable.

It does **not** mean:

> the caller is authorized to execute every operation that implementation can perform.

Execution still requires immutable ExecutionContext + Policy/Approval evaluation.

### Context isolation is not OS isolation

Context `isolate`/realm semantics can cause the same logical Service Key to resolve to different implementations for:

- different Workspaces;
- different Agents;
- Shadow Contexts;
- test environments.

This is service-resolution isolation only.

It is not:

- filesystem confinement;
- Windows token restriction;
- process sandboxing;
- network sandboxing.

Hard confinement still requires restricted account/container/VM/Worker/Broker mechanisms.

### Component permission declarations

A Component may declare requested permissions/capabilities as metadata.

Those declarations are inputs to Policy/review.
They are not grants.

No Component may:

- force Policy allow;
- approve itself;
- widen Workspace roots;
- convert a Tool Profile to a more privileged one;
- replace Approval verification through ordinary hot reload.

### Monotonic restrictions

Composition interceptors/guards may add restrictions.

They must not turn a Core Policy denial into allow.

This preserves one-way authority narrowing through the Composition Kernel.

### Effect boundary

Only runtime-local E1 effects are automatically reverted on Fiber unload.

E2/E3/E4 effects such as:

- process/worktree/resource allocations;
- file/Git mutations;
- external remote writes;
- firmware flashing;
- host/system changes;

continue to use durable resource/Capability/Approval rules.

A disposer is not a security proof and does not make an external mutation safely reversible.

### Trust Kernel

The following remain outside ordinary self-HMR by default:

- identity/authentication;
- Workspace authority;
- Policy;
- Approval verification;
- durable State Store integrity;
- Audit integrity;
- Broker trust anchors.

Changes to these modules use the verified self-development/restart path rather than Component-level hot replacement.
