# P05 V3 Remote Host Session / SSH Authority Requirements

Status: Accepted V3 requirement baseline
Scope: SSH / remote host control / remote shell / approval efficiency
Purpose: define how P05 controls remote servers without per-command approval friction

## 1. Core principle

V3 SHALL NOT approve SSH one command at a time by default.

SSH and equivalent remote-control transports SHALL be modeled as an authorized Remote Host Session.

Authorization is granted to a bounded session context:

    Remote Host
    + Principal
    + Remote Workspace
    + Allowed Effects
    + Duration

Commands that remain inside the granted boundary may execute without repeated human approval.

A new approval is required only when execution expands or changes the authorized boundary.

## 2. Remote Host Session model

A Remote Host Session SHALL have a stable session identity and SHALL include at least:

- sessionId;
- remote host identity;
- transport type, initially including SSH;
- remote principal/user;
- remote Workspace/root;
- granted authority/effect set;
- security mode;
- creation time;
- expiry/lifetime;
- state;
- parent Runtime/Execution identity.

Conceptually:

    Local P05
       |
       v
    Remote Host Session
       |
       +-- Host: H1
       +-- Transport: SSH
       +-- Principal: user
       +-- Workspace: /home/user/project
       +-- Effects: Read + WorkspaceWrite + Execute + LocalGit
       +-- Duration: Session
       |
       v
    Remote shell / git / build / test / process

## 3. Host trust

### V3-SSH-01 — Stable remote host identity

A remote host SHALL NOT be identified only by an IP address or hostname string.

The trusted host record SHOULD include:

- logical Host ID;
- hostname/address;
- SSH host key fingerprint or equivalent cryptographic identity;
- known aliases/endpoints;
- last verified time.

### V3-SSH-02 — Host-key change requires confirmation

If a previously trusted SSH host presents a different host key, P05 SHALL NOT silently continue.

The session SHALL enter a state equivalent to:

    HOST_IDENTITY_CHANGED
      -> CONFIRM

until the user explicitly accepts the new identity.

## 4. Principal and Workspace authority

### V3-SSH-03 — Principal-bound session

Each Remote Host Session SHALL be bound to the actual remote principal/user.

Changing from one principal to another SHALL require a new authority evaluation.

Privilege escalation such as ordinary user -> root/sudo SHALL be treated as an authority expansion.

### V3-SSH-04 — Remote Workspace boundary

A Remote Host Session SHALL be bound to one authorized remote Workspace/root or an explicit set of authorized roots.

Workspace-safe operations may execute automatically when allowed by the session authority.

Persistent write outside the authorized remote Workspace SHALL require additional approval or be denied by policy.

## 5. Effect-based approval

### V3-SSH-05 — Session authority uses Effect classes

Remote-session authorization SHALL be expressed using Effect/Authority semantics, not command-name allowlists.

Representative effects include:

- Read;
- WorkspaceWrite;
- Execute;
- LocalGit;
- Network;
- External;
- HostWrite;
- PrivilegeEscalation;
- Hardware.

The actual V3 Capability Effect Model remains authoritative.

### V3-SSH-06 — Normal development operations can auto-run inside boundary

Once a session is authorized for a remote Workspace with suitable effects, normal development operations SHOULD NOT require repeated approval.

Examples include, when inside the granted boundary:

- file read/list/search;
- file modification;
- local Git status/diff/add/commit;
- build commands;
- test commands;
- project-local Python/Node/CMake/Ninja/Make execution;
- project-local process start/stop;
- log inspection.

Automatic execution depends on the effective Sandbox/Policy level and granted session authority.

### V3-SSH-07 — Boundary expansion triggers approval

A new approval SHALL be required when the requested operation expands beyond the existing session authority.

Examples include:

- write outside remote Workspace;
- access to protected host paths such as /etc;
- sudo/root or equivalent privilege escalation;
- system service modification;
- firewall changes;
- user/account changes;
- system package installation;
- external Git push;
- new external API/service mutation;
- new network scope;
- hardware/firmware operations;
- destructive host-level actions.

The approval SHALL describe the authority/effect expansion rather than merely repeat the command string.

## 6. Approval scope

### V3-SSH-08 — Approval is granted to a structured scope

Remote-session approval SHOULD support scopes such as:

- once;
- current Execution/Run;
- current Remote Host Session;
- current Runtime Session;
- persistent Workspace/Host rule where explicitly chosen.

A representative approved scope is:

    Host = H1
    Principal = user
    Workspace = /home/user/project
    Allow Effects = Read + WorkspaceWrite + Execute + LocalGit
    Confirm Effects = HostWrite + External + PrivilegeEscalation
    Duration = current session

### V3-SSH-09 — Do not persist broad command-string trust

P05 SHOULD NOT use rules such as:

    always allow ssh
    always allow npm
    always allow python

as the primary trust mechanism.

Persistent permission rules SHALL bind to structured identity, scope and effects.

## 7. Execution and audit

### V3-SSH-10 — Remote execution carries session identity

Every remote execution SHALL record the Remote Host Session identity in its ExecutionContext/Audit lineage.

A remote execution record SHOULD answer:

- which local Runtime initiated it;
- which remote Host;
- which SSH principal;
- which remote Workspace;
- which Host Session;
- which Capability;
- which Effect;
- which Permission/Approval decision;
- final completion state.

### V3-SSH-11 — Same durable execution semantics

Remote SSH operations SHALL use the same durable execution/completion model as local operations.

That includes:

- stable executionId;
- WAITING_APPROVAL where needed;
- automatic resume after approval;
- RUNNING;
- SUCCEEDED / FAILED / INTERRUPTED / UNKNOWN;
- direct completion lookup;
- reconnect/reconciliation.

Remote transport disconnect SHALL NOT be automatically equated with remote execution failure.

## 8. Session lifecycle

### V3-SSH-12 — Explicit Remote Host Session lifecycle

A Remote Host Session SHALL have explicit lifecycle/state semantics such as:

    CREATED
    CONNECTING
    ACTIVE
    DEGRADED
    EXPIRED
    CLOSED
    FAILED

The exact vocabulary may evolve, but active authority and expired authority SHALL be distinguishable.

### V3-SSH-13 — Session expiry and revocation

Session authority SHALL be revocable.

Session expiration or explicit revocation SHALL prevent new executions from using the expired authority.

Existing in-flight work SHALL follow the durable execution/reconciliation rules.

## 9. Platform neutrality

### V3-SSH-14 — SSH is one Remote Host transport, not the architecture

The authority/session model SHALL remain transport-neutral.

SSH is the first required transport for Linux/server workflows, but the same model SHOULD support future remote transports where appropriate.

Remote Host Session semantics SHALL not depend on Windows- or Linux-specific implementation details.

## 10. Security relationship

Remote Host Session authority does not replace:

- Permission Broker;
- Approval;
- Capability Effect Model;
- Sandbox-aware Policy;
- Execution Identity;
- Audit;
- Trusted/Immutable Runner rules.

Instead:

    Remote Host Session
        -> defines bounded remote authority context
        -> every operation still passes unified execution boundary

## 11. Target user experience

The intended interaction is:

    First use:
      "Allow Runtime A to connect to H1 as user,
       operate within /home/user/project,
       with Read + WorkspaceWrite + Execute + LocalGit
       for this Session?"

      -> Allow

    Then:
      edit
      build
      test
      local git
      inspect logs
      run project processes

      -> automatic within the session boundary

    Later:
      sudo apt install ...

      -> WAITING_APPROVAL
         reason: PrivilegeEscalation + HostWrite

This preserves safety without turning normal remote development into per-command approval.

## 12. Acceptance criteria

V3 remote-host control is not complete until:

1. a trusted remote Host has stable identity;
2. host-key changes trigger confirmation;
3. Session authority is bound to a remote principal;
4. Session authority is bound to a remote Workspace/scope;
5. normal in-scope development commands do not require repeated approval;
6. privilege escalation triggers approval;
7. remote Workspace escape triggers approval;
8. HostWrite / External / Hardware effects can be independently controlled;
9. approval can be granted for a bounded Session scope;
10. each remote execution is attributable to Host + Principal + Workspace + Session;
11. remote executions use durable execution/completion state;
12. Operator and remote clients see the same authoritative state.

## 13. Development rule

Future P05 SSH/server-control development SHALL use this Remote Host Session authority model as the baseline.

Do not implement SSH as a raw unrestricted shell transport and do not implement normal development as one-approval-per-command.
