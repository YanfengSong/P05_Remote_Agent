# P05 V3 Core Managed Service / Sidecar Control

Status: Accepted Core sub-design
Scope: Core supervision / managed services
Reference implementation: HTTP Reviewer
Migration principle: V2 validates the capability; V3 generalizes the mechanism.

## 1. Decision

V3 Core MUST provide a generic control plane for P05-managed sidecar/services.

This capability belongs in Core because lifecycle supervision, health, desired/observed state, slot binding, recovery and failure isolation are control-plane responsibilities.

However, specific service business implementations MUST remain outside Core.

Therefore:

> Core owns managed-service control semantics; Components/Sidecars own their business behavior.

## 2. What belongs in Core

Core Managed Service Control includes:

- service registry metadata;
- desired state;
- observed/live state;
- enable/disable intent;
- start/stop/restart control;
- health/state reporting;
- Slot/Runtime binding;
- bounded dependency metadata;
- persistence of desired state;
- crash-loop/backoff integration;
- diagnostics;
- failure isolation;
- reconciliation between desired and observed state.

This is a specialization of Core Supervision, not a new business subsystem.

## 3. What does not belong in Core

Core MUST NOT absorb:

- HTTP Reviewer business logic;
- Public Tunnel implementation;
- Web Dashboard logic;
- Telemetry business logic;
- MATLAB/STM32 domain logic;
- arbitrary Component/Fiber execution internals;
- service-specific OAuth/application behavior;
- service-specific protocol/business routing;
- package download/install implementation.

Core can supervise these systems without implementing them.

## 4. Provisioning boundary

Deployment/Bootstrap owns provisioning.

Conceptually:

    Deployment / Bootstrap
      -> install/provision service package
      -> verify host dependencies
      -> register service metadata

    Core Managed Service Control
      -> enable/disable desired state
      -> start/stop/restart
      -> observe health/live state
      -> reconcile
      -> diagnose failures

Rule:

> Deployment owns provisioning; Core owns runtime control.

Core MUST NOT evolve into a general package manager.

## 5. Service state model

A managed service MUST distinguish at least:

### Installed / Available

Whether a provisioned service implementation exists and can potentially run.

### Desired State

Whether the control plane wants the service enabled/running for a given scope.

Representative values:

    enabled
    disabled

### Observed State

What is actually happening now.

Representative values:

    stopped
    starting
    running
    stopping
    failed
    unavailable
    crash_loop

Exact state names may be refined during implementation.

Desired state and observed state are not the same thing.

Examples:

    desired = enabled
    observed = failed

    desired = disabled
    observed = stopped

## 6. Service identity and metadata

A managed service descriptor SHOULD contain platform-neutral metadata equivalent to:

    id
    kind
    version
    availability
    desiredState
    observedState
    health
    scope
    slotBinding
    dependencies
    restartPolicy
    hostRequirements
    diagnostics

Service identity must be stable and must not depend on one concrete process id.

## 7. Slot / Runtime binding

A service MAY bind to a specific P05 Runtime Slot such as A or B.

Example:

    service: http-reviewer
    slotBinding: B

This means the service is associated with Runtime B''s operating context.

It does NOT mean the service must be a child process of Runtime B.

The service may remain an independent process supervised by the Core/Host control plane.

## 8. Dependency semantics

A managed service MAY declare bounded service dependencies.

Example:

    public-tunnel
      depends_on:
        - http-reviewer

Core may use this metadata for lifecycle ordering and health interpretation.

This does NOT turn Core into a general workflow/orchestration engine.

Complex business dependency graphs remain outside this subsystem.

## 9. Lifecycle independence

Runtime lifecycle and Sidecar lifecycle MUST NOT be implicitly coupled.

Examples:

- restarting Runtime B does not automatically imply that every bound Sidecar must restart;
- restarting a Sidecar does not automatically restart Runtime B;
- explicit dependency/restart policy may define a relationship where needed.

Lifecycle coupling must be declared, not assumed.

## 10. Public exposure separation

Public network exposure MUST remain separate from the business service itself.

Example:

    HTTP Reviewer
      -> local service

    Public Tunnel
      -> separate managed service
      -> depends on HTTP Reviewer
      -> exposes reviewer externally

This prevents public exposure logic from becoming embedded inside business service lifecycle code.

## 11. Operator contract

Operator/UI must use the same generic Core managed-service control interface.

Operator SHOULD NOT implement service-specific lifecycle paths such as:

    reviewer_start
    reviewer_stop
    reviewer_restart

Instead it should operate through generic service control semantics.

Service-specific UI may display domain details, but lifecycle authority remains generic.

## 12. Relationship to Plugin / Component / Fiber

This design does not redefine the whole Component/Fiber architecture.

The practical mapping is:

    Plugin
      = capability/package ownership

    Component
      = composable runtime/service unit

    Fiber
      = one live Component instance

A managed Sidecar such as HTTP Reviewer can be represented as a Component with one or more live Fibers, but Core only needs the control-plane contract required to supervise it.

Core MUST NOT become the full general Component execution runtime merely because it manages Sidecars.

## 13. HTTP Reviewer reference mapping

V2 already proves the capability:

- HTTP Reviewer can run as an independent process;
- it can bind to Runtime B;
- it exposes readonly MCP/review behavior;
- OAuth/public exposure can be optional;
- Public Tunnel can be operated separately.

V3 migration:

    V2 special Reviewer scripts/config
      -> generic Managed Service descriptor
      -> generic desired/observed state
      -> generic lifecycle control
      -> generic health/supervision
      -> generic Slot binding

The Reviewer business implementation itself is reused rather than moved into Core.

Reference descriptor:

    id: http-reviewer
    kind: sidecar-service
    scope: slot
    slotBinding: B
    desiredState: enabled

Observed example:

    state: running
    health: healthy

## 14. Public Tunnel reference mapping

Example:

    id: public-tunnel
    kind: infrastructure-sidecar
    dependsOn:
      - http-reviewer

    target:
      service: http-reviewer

The tunnel is a distinct managed service.

It is not part of HTTP Reviewer business logic.

## 15. Failure semantics

Managed-service failure MUST NOT make Core unavailable.

Core should integrate with existing Runtime Supervision semantics:

- bounded retries;
- backoff;
- restart budget;
- crash-loop detection;
- explicit failure state;
- diagnostics;
- manual retry/restart path.

A failed Sidecar affects only its own service/dependents unless an explicit dependency says otherwise.

## 16. Security

Service lifecycle control remains subject to Core Policy/Approval.

Enabling or starting a service:

- does not grant new Workspace authority;
- does not bypass Plugin/Component permissions;
- does not grant host privileges by itself;
- cannot silently modify another Slot''s state;
- cannot bypass Host Adapter or broker boundaries.

Service metadata visibility is not execution authority.

## 17. Platform portability

Managed Service Control is platform-neutral.

Windows implementation may use Windows-specific Host Adapter mechanisms.

Linux implementation may use systemd/process-group/other Host Adapter mechanisms.

Core state and lifecycle contracts MUST remain the same across supported Hosts.

## 18. V2 to V3 migration rule

V3 does not rewrite working V2 services solely for architectural purity.

The migration sequence is:

1. keep the working V2 service implementation;
2. describe it through the generic Managed Service contract;
3. move special lifecycle/config/state logic into generic control-plane mechanisms;
4. retain service-specific business behavior outside Core;
5. validate equivalent behavior before deleting old special-case paths.

Principle:

> V2 validates the capability; V3 generalizes the mechanism.

And:

> V3 generalizes the control mechanism, not the business implementation.

## 19. Core boundary statement

Managed Service Control belongs under Core Supervision.

The accepted Core responsibility is:

    Core
      -> Registry
      -> Desired State
      -> Observed State
      -> Reconciliation
      -> Health
      -> Lifecycle Control
      -> Failure Isolation
      -> Slot Binding

The service implementation remains outside Core.

## 20. Acceptance criteria

1. HTTP Reviewer can be represented without Reviewer-specific lifecycle code in Core.
2. Public Tunnel can be represented as a separate managed service.
3. A service can be enabled/disabled independently of Runtime A/B.
4. A service can bind to Slot A or B without becoming a child of that Runtime.
5. Runtime and Sidecar lifecycle remain independent unless explicitly coupled.
6. Service failure does not affect Core readiness.
7. Operator can manage services through one generic interface.
8. Future Sidecars can be added without modifying Core business-specific code.
9. Provisioning remains outside Core runtime control.
10. The same control contract can be implemented on Windows and Linux.

