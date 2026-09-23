# P05 V3 Security Requirements

Status: Accepted V3 requirement baseline
Scope: V3 security / execution / trust architecture
Origin: V2 limitations and V3 security planning
Implementation phase: V3
V2 rule: do not force these architectural changes into V2

## 1. Objective

V3 security must evolve from policy-only guardrails toward a unified execution and isolation architecture.

The target security flow is:

    Agent / Tool
        |
        v
    Capability + Effect
        |
        v
    Permission Broker
    ALLOW / CONFIRM / DENY
        |
        v
    Execution Boundary
        |
        v
    Sandbox / Trusted Broker
        |
        v
    Host / Workspace / Network / External System

The model separates:

- authorization;
- approval;
- execution containment;
- host authority;
- Workspace authority;
- network authority;
- external-system effects.

## 2. V3 requirements

### V3-SEC-01 ? OS-level Sandbox / Workspace-write Sandbox

V3 SHALL provide a path toward real OS-level isolation for arbitrary Shell/Python/MATLAB/code execution.

Goal:

- technically prevent unauthorized writes outside the permitted Workspace;
- avoid relying only on AI behavior rules, cwd restrictions or command blocklists;
- allow the execution backend to prove the effective containment level.

This belongs in V3 because real containment requires a new execution-isolation layer.

### V3-SEC-02 ? Unified Execution Boundary

Shell, code execution, downstream MCP, Plugin execution, task execution and future Agent/Worker execution SHALL converge on one execution-boundary contract.

The boundary SHALL consistently apply:

- identity;
- authority;
- effect classification;
- Policy;
- Approval;
- Sandbox/Runner selection;
- timeout/resource limits;
- audit;
- verification.

Domain implementations may differ, but they SHALL NOT invent independent security semantics.

### V3-SEC-03 ? Trusted / Immutable Runner

Critical platform operations such as build/test/verify/restart SHALL NOT depend solely on scripts that the Agent can modify and immediately execute under the same authority.

V3 SHALL support a trusted runner/broker path for security-sensitive platform operations.

The trusted execution path SHOULD be:

- outside ordinary self-modifying source;
- narrowly parameterized;
- versioned/verified;
- independently provisioned where host authority is required.

### V3-SEC-04 ? Permission Broker Service

V3 SHALL define a unified Permission Broker abstraction.

The Permission Broker SHALL provide the authoritative decision contract for:

    ALLOW
    CONFIRM
    DENY

If implemented as an independently managed service/component, it SHALL remain part of the trusted security/control architecture rather than ordinary hot-reloadable application logic.

### V3-SEC-05 ? Capability Effect Model

Every executable Capability SHALL declare or resolve its effect class.

Initial effect classes to design include at least:

- Read;
- Workspace Write;
- Execute;
- Host;
- Network;
- External.

The model MAY later refine effects further.

Effect classification SHALL be machine-readable and available to Policy/Approval.

### V3-SEC-06 ? Sandbox-aware Policy

Policy decisions SHALL consider the actual execution isolation level.

The same operation may receive a different default decision depending on whether execution occurs in:

- trusted host;
- constrained host;
- sandboxed Workspace;
- isolated Worker;
- other future containment mode.

A capability SHALL NOT claim a stronger sandbox level than the execution backend can actually enforce.

### V3-SEC-07 ? Plugin Runtime Isolation

Plugin permissions SHALL evolve beyond declaration-only metadata.

V3 SHALL provide a mechanism to constrain Plugin execution according to granted authority, including where applicable:

- Host access;
- Workspace filesystem access;
- downstream MCP access;
- process execution;
- network access;
- external-system access.

Plugin isolation semantics SHALL remain separate from Plugin business logic.

### V3-SEC-08 ? Downstream MCP Isolation

External/downstream MCP servers SHALL be treated as a trust boundary.

V3 SHALL define how a downstream server is constrained with respect to:

- filesystem;
- Workspace;
- network;
- Host processes;
- credentials/secrets;
- external systems.

Connecting a downstream MCP server SHALL NOT implicitly grant the full authority of the P05 host process.

### V3-SEC-09 ? Process / Terminal Sandbox

Long-lived Process and Terminal Sessions SHALL have explicit security and Workspace-isolation semantics.

V3 SHALL define:

- execution identity;
- Workspace binding;
- filesystem boundary;
- environment exposure;
- process-tree ownership;
- network policy;
- lifetime;
- cleanup/recovery.

Terminal flexibility SHALL NOT be mistaken for containment.

### V3-SEC-10 ? Network Permission Model

Network access SHALL become an explicit permission/effect dimension.

The model SHOULD distinguish at least:

- no network;
- local-only;
- approved endpoints/domains;
- general outbound;
- inbound/public exposure;
- Git remote;
- external API/service access.

Network authority SHALL be independently controllable from filesystem authority.

### V3-SEC-11 ? Read-only Reference Mount

When a Sandbox/isolated execution backend is used, Reference Roots SHOULD be exposed through technically read-only mechanisms where supported.

Examples include:

- read-only mounts;
- ACL;
- container/namespace mount flags;
- equivalent OS-enforced protections.

A logical "reference/read-only" designation SHOULD NOT rely solely on convention when the backend supports stronger enforcement.

### V3-SEC-12 ? Windows Sandbox Backend

V3 SHALL evaluate mature Windows execution-isolation backends rather than inventing a custom sandbox mechanism.

Candidate areas to research include:

- Windows native restricted-token approaches;
- AppContainer or related Windows isolation primitives;
- container/VM approaches;
- mature open-source agent sandbox implementations;
- Codex-like native Windows sandboxing patterns where publicly documented.

The final backend choice remains an implementation/design decision.

### V3-SEC-13 ? Persistent Permission Rules

V3 SHALL support durable user permission preferences in addition to one-time approvals.

Representative policy states:

    Allow
    Confirm
    Deny

Rules SHOULD be persistable for selected scopes such as:

- Tool;
- Plugin;
- Workspace;
- Runtime;
- operation/effect class.

Persistent permission SHALL remain revocable and auditable.

### V3-SEC-14 ? Permission Scope Hierarchy

V3 SHALL define explicit permission inheritance/override semantics across a hierarchy equivalent to:

    Global
      -> Runtime
      -> Workspace
      -> Plugin / Component
      -> Tool / Capability
      -> Operation / Effect

The exact precedence rules SHALL be deterministic.

A narrower scope SHALL NOT silently widen authority granted by a stricter higher-level boundary unless the architecture explicitly permits and audits that override.

### V3-SEC-15 ? Security Trust Kernel

Security-critical authority state SHALL be isolated from ordinary self-modifying or hot-reloadable application logic.

The Trust Kernel includes or governs at least:

- Permission/Policy;
- Workspace Authority;
- Approval verification;
- security-critical Audit state;
- execution identity;
- trusted configuration required to establish authority.

Ordinary Plugin/Component updates SHALL NOT be able to replace or weaken the Trust Kernel.

### V3-SEC-16 ? Execution Identity

Every protected execution SHALL carry a stable authorization context identifying the relevant actors/scopes.

The V3 model SHALL define identities for at least:

- Host;
- Runtime/Slot;
- Core instance/generation;
- Client;
- Agent where applicable;
- Workspace;
- Plugin/Component;
- Tool/Capability;
- operation/request.

Authorization and Audit SHALL use explicit identity rather than implicit global state.

## 3. Security architecture target

The V3 security target is:

    Agent / Tool
        |
        v
    Capability + Effect
        |
        v
    Permission Broker
        |
        +-- ALLOW
        +-- CONFIRM
        +-- DENY
        |
        v
    Unified Execution Boundary
        |
        +-- identity
        +-- authority
        +-- resource limits
        +-- audit
        +-- verification
        |
        v
    Execution Backend
        |
        +-- OS Sandbox
        +-- Trusted Runner / Broker
        +-- Isolated Worker
        +-- constrained host mode
        |
        v
    Host / Workspace / Network / External System

## 4. Core / Host / Optional boundary

These requirements do NOT mean every security mechanism runs inside the Core process.

### Core / Trust Kernel responsibility

Core/Trust Kernel owns the authoritative semantics for:

- identity;
- capability/effect classification;
- Policy;
- Permission decision;
- Approval;
- Workspace authority;
- execution-boundary selection;
- security state/diagnostics.

### Host Adapter / Trusted Broker responsibility

OS-specific enforcement belongs behind Host/Execution backends:

- Windows sandbox;
- Linux sandbox;
- process/user/container isolation;
- trusted build/test/restart broker;
- read-only mount implementation;
- low-level network restriction.

### Optional Runtime / Plugin responsibility

Plugins declare requirements and execute domain logic.

They SHALL NOT:

- grant themselves authority;
- bypass the execution boundary;
- select a weaker sandbox than Policy permits;
- modify Trust Kernel decisions.

## 5. Relationship to current V2

V2 already contains useful security foundations:

- Workspace boundaries for structured tools;
- Tool Profiles;
- Policy/Execution lifecycle;
- Approval-oriented operating rules;
- sensitive-path protection;
- audit/recovery metadata;
- external restart broker;
- explicit statement that trusted shell is not a sandbox.

V3 SHALL reuse these foundations.

V3 is not a rewrite of V2 security.

The V3 upgrade is:

    V2 logical policy/guardrails
        +
    V3 explicit identity/effect model
        +
    unified execution boundary
        +
    real containment backends
        +
    durable permission model
        +
    Trust Kernel isolation

## 6. Mature-model research direction

During V3 design/research, evaluate mature patterns rather than creating isolation/security mechanisms from scratch.

Reference directions to investigate include:

- Codex: sandbox and approval separation;
- Zed: unified Tool/MCP permission model and durable decisions;
- Cline: tool-level approval/auto-approve patterns;
- OpenHands: isolated runtime/sandbox model;
- MCP ecosystem/security guidance: downstream trust boundary and least privilege.

These references are design inputs only.

Their exact current behavior SHALL be verified from primary/up-to-date sources before adopting a mechanism.

## 7. Cross-cutting relationships

These security requirements interact with existing V3 architecture work:

- Platform Portability / Host Adapter;
- Core Managed Service Control;
- Plugin Desired State;
- Multi-Runtime Shared Resource Coordination;
- Runtime Supervision;
- Process/Terminal isolation;
- Capability Binding;
- Resource Leases;
- durable approval/audit;
- Core upgrade/recovery.

Security requirements SHALL be applied across these subsystems rather than implemented as one isolated feature.

## 8. V2 implementation rule

Do NOT force V3-SEC-01 through V3-SEC-16 into the current V2 branch as ad-hoc patches.

V2 may receive bounded safety/stability fixes that preserve its current architecture.

Architectural changes requiring:

- new sandbox backend;
- unified execution boundary;
- Trust Kernel separation;
- persistent permission hierarchy;
- process/downstream isolation;
- new execution identity model;

belong to V3.

## 9. Acceptance direction

V3 security design is not considered complete until the architecture can answer:

1. Who is executing?
2. Under which Runtime/Workspace/Client identity?
3. What Capability is being invoked?
4. What effects can it produce?
5. Is it ALLOW/CONFIRM/DENY?
6. Which execution backend enforces the decision?
7. What filesystem/Host/network/external authority does that backend actually provide?
8. Can a Plugin/downstream server exceed the granted authority?
9. Can self-modifying code replace the security decision path?
10. Can the action be audited and recovered safely?

