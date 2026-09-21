# P05 Permission and Self-Development Model

Updated: 2026-09-20
Foundation: V2

## Core rule

**Self-development is allowed; self-authorization is not.**

## Authority layers

### 1. Tool profile

- discovery: identity/health;
- readonly: Workspace/control inspection and bounded read operations;
- developer: Workspace mutation, local Git mutation, platform validation, trusted shell, restart request and downstream discovery;
- full: external Git push and generic downstream execution.

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

### 7. External host broker

Host-level actions should use narrow externally provisioned brokers.

Current example:

    schtasks.exe /Run /TN P05-RestartBroker

The Agent cannot choose another task or rewrite the broker through the structured developer surface.

## Operation classes

| Class | Examples | Normal authority |
|---|---|---|
| Observe | fs_read, fs_list, git_status, activity_recent | readonly |
| Workspace mutate | fs_write, apply_patch, git_add, git_commit, git_branch | developer |
| Platform execute | command_run(check/build/verify) | developer, fixed platform-source |
| Trusted terminal | shell_run | developer; cwd-confined only, not sandboxed |
| Host lifecycle | runtime_restart | developer + external broker |
| External remote mutate | git_push | full |
| Generic downstream execute | mcp_call_tool | full |
| Host/system mutate | services, firewall, registry, system packages | approval/broker |

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

## Shell exception

`shell_run` is intentionally broader than structured tools.

P05 enforces the starting cwd against the active Workspace. It does **not** claim that PowerShell itself is confined there.

Therefore the operating requirement:

> Persistent modification outside the authorized Workspace requires explicit user approval.

is a behavior/approval contract, not an OS sandbox.

If that rule must become technically unavoidable, use:
- restricted account;
- container/dev container;
- VM;
- dedicated worker;
- external execution broker.

Do not attempt to simulate a sandbox with a larger command blacklist.

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

- ADR-0007: External Restart Broker
- ADR-0008: Developer Shell Trust Model
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
