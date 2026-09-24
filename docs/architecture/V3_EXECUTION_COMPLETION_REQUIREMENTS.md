# P05 V3 Execution Completion Requirements

Status: Accepted V3 requirement baseline
Scope: execution completion / durable operation tracking / timeout semantics
Purpose: ensure remote call waiting state and actual host-side execution state remain distinct and reliably reconcilable

## 1. Problem statement

V2 has exposed an important execution-lifecycle gap.

A representative path is:

    shell_run
        -> execution lifecycle
        -> local process / Operator control action
        -> caller waits for response
        -> caller-side timeout or transport interruption
        -> host-side operation may still complete successfully
        -> final success is visible only later through activity/audit inspection

This creates an ambiguous state:

> the caller times out, but the host operation may already have succeeded.

The current workaround is often:

    call times out
        -> do not retry immediately
        -> query activity_recent / recovery / host state
        -> infer the actual result

That is operationally safe, but inefficient and too indirect.

V3 SHALL make execution completion a first-class durable contract.

## 2. Design principle

The architecture SHALL distinguish at least three different facts:

    1. Request / transport state
    2. Caller wait state
    3. Actual execution state

They are not equivalent.

In particular:

> caller wait timeout != execution timeout != execution failure

and:

> transport disconnect != host operation failure

Approval follows the same principle:

> approval wait != execution failure

and:

> approval resolution is a state transition of the same execution, not a request to create a new execution.

## 3. Requirements

### V3-EXEC-01 — Stable Execution Identity

Every protected or potentially long-running execution SHALL receive a stable execution identity before or at the point the operation becomes externally observable.

The execution identity SHALL be usable to correlate:

- original request;
- Permission / Approval;
- local process or managed action;
- Audit;
- completion state;
- reconnect/query;
- recovery.

A caller SHALL NOT need to infer operation identity from timestamps or command text.

### V3-EXEC-02 — Acknowledgement before disruptive execution

For operations that may interrupt their own control channel, the system SHALL provide an acknowledgement before the disruptive step begins whenever technically possible.

Examples include:

- Runtime restart;
- Operator restart;
- tunnel restart;
- service restart;
- process replacement;
- host-side lifecycle transitions that can break the active connection.

The acknowledgement SHALL include the execution identity and enough state to distinguish:

    accepted / started

from:

    completed

A pre-disruption acknowledgement is not a success result.

### V3-EXEC-03 — Caller wait timeout is not execution outcome

A caller-side wait timeout SHALL NOT be recorded as host-side execution failure unless the execution itself has actually failed or exceeded its own execution deadline.

The runtime SHALL preserve the real operation state independently of:

- MCP request timeout;
- HTTP timeout;
- client timeout;
- UI wait timeout;
- connector/tunnel interruption.

If the caller stops waiting while the operation continues, the state SHALL remain queryable.

### V3-EXEC-04 — Separate timeout classes

V3 SHALL distinguish timeout classes such as:

- request/transport timeout;
- caller wait timeout;
- approval timeout;
- queue timeout;
- execution timeout;
- child-process timeout;
- stabilization timeout;
- completion-report timeout.

The timeout category SHALL be visible in diagnostics.

A timeout in one category SHALL NOT silently overwrite another state.

### V3-EXEC-05 — Durable execution state

Once an execution has been accepted, its lifecycle state SHALL be durable enough to survive ordinary Runtime/connection interruption where applicable.

The execution model SHALL support states compatible with the durable Run model, including at least the semantics of:

- accepted/created;
- running;
- waiting where applicable;
- succeeded;
- failed;
- cancelled;
- interrupted;
- unknown/reconciliation-required.

The exact state vocabulary may reuse the V3 Run Kernel state machine.

Final state SHALL be authoritative and SHALL not depend on whether the original caller was still connected.

### V3-EXEC-06 — Direct completion query

V3 SHALL provide a direct status/completion lookup by execution identity.

The caller SHALL be able to ask conceptually:

    execution_status(executionId)

and receive the authoritative execution state.

This is distinct from browsing generic recent activity.

activity/audit remains useful for observability and history, but it SHALL NOT be the only way to discover whether one known operation actually completed.

### V3-EXEC-07 — Reconnect and completion reconciliation

After reconnect, the caller SHALL be able to reconcile an in-flight or recently interrupted operation using its stable execution identity.

The system SHOULD support one or more of:

- direct status query;
- completion event replay;
- resumable status stream;
- bounded completion notification;
- reconciliation on reconnect.

The mechanism may vary by transport, but execution truth SHALL remain transport-independent.

### V3-EXEC-08 — Connection-disrupting lifecycle completion

Lifecycle operations that intentionally restart or replace a process SHALL define explicit completion semantics.

For example, an Operator restart should distinguish:

    request accepted
        -> old Operator stopping
        -> new Operator started
        -> health/readiness verified
        -> execution completed

If the original connection disappears between these stages, the completion record SHALL still converge to the actual final state.

"Connection closed" is not a sufficient lifecycle result.

### V3-EXEC-09 — Safe retry and duplicate suppression

When the caller cannot determine whether an operation completed, retry behavior SHALL be safe.

Potentially disruptive or non-idempotent operations SHALL use one or more of:

- idempotency key;
- execution identity;
- duplicate detection;
- operation-specific reconciliation;
- explicit UNKNOWN state requiring inspection.

The system SHALL avoid treating an uncertain response as permission to blindly run the same restart/mutation twice.

### V3-EXEC-10 — Completion truth separate from Audit browsing

Audit SHALL record execution history and evidence.

Execution completion SHALL have its own authoritative state contract.

The normal caller flow SHOULD be:

    invoke
      -> executionId
      -> wait / reconnect
      -> execution completion

rather than:

    invoke
      -> timeout
      -> search recent activity
      -> infer likely result

### V3-EXEC-11 — Operator and remote client use the same execution truth

Local Operator, remote MCP clients and future UI surfaces SHOULD read the same authoritative execution state.

Different surfaces SHALL NOT independently infer whether the same operation succeeded.

This includes:

- Shell execution;
- Runtime lifecycle actions;
- Managed Service actions;
- Plugin lifecycle actions;
- future Workflow/Skill Runs where applicable.

### V3-EXEC-12 — Completion diagnostics

For incomplete or uncertain executions, diagnostics SHALL explain why completion is not yet known.

Examples:

- caller disconnected;
- child process still running;
- replacement process not yet ready;
- stabilization check failed;
- completion callback lost;
- execution owner interrupted;
- state requires reconciliation.

The system SHOULD expose the next safe action:

- continue waiting;
- query again;
- inspect;
- reconcile;
- retry;
- request human action.

### V3-EXEC-13 — Approval as a durable execution wait state

Approval SHALL be represented as a waiting state of the same durable execution.

Conceptually:

    CREATED
      -> PREPARING
      -> AUTHORIZING
      -> WAITING_APPROVAL
      -> RUNNING
      -> VERIFYING
      -> SUCCEEDED / FAILED

An operation entering approval SHALL NOT be treated as failed merely because execution has paused for human authorization.

### V3-EXEC-14 — Approval identity linked to execution identity

Approval and execution SHALL have distinct stable identities.

Conceptually:

    Execution E123
      -> Approval A456

The Approval record SHALL reference the Execution it governs.

The Execution SHALL expose whether it is waiting on an Approval and which Approval is pending.

This preserves a clean distinction between:

- work identity;
- authorization decision identity.

### V3-EXEC-15 — Approval resolution resumes the original execution

When an Approval is resolved as ALLOW, the original waiting Execution SHALL resume.

The normal flow SHALL be:

    Execution E123
      -> WAITING_APPROVAL
      -> Approval A456 = ALLOWED
      -> E123 AUTHORIZED
      -> E123 RUNNING
      -> E123 SUCCEEDED / FAILED

The caller SHALL NOT be required to submit the same operation a second time merely to consume an approval.

A second invocation SHOULD NOT create a new Execution for work that is already represented by the approved waiting Execution.

### V3-EXEC-16 — Deny and expiry are explicit execution outcomes

Approval decisions SHALL map deterministically into the waiting Execution lifecycle.

At minimum:

- ALLOW -> resume authorization/execution;
- DENY -> terminal denied/failed authorization state;
- EXPIRE -> explicit approval-expired state or terminal authorization failure according to policy;
- CANCEL -> explicit cancellation where supported.

The resulting Execution state SHALL remain queryable by execution identity.

### V3-EXEC-17 — Approval event propagation

Approval state changes SHALL be observable through the same durable state/event infrastructure used for execution completion.

When an Approval changes state, interested surfaces SHOULD be able to observe the transition without polling generic recent activity.

Relevant consumers include:

- Local Operator;
- remote MCP caller;
- Workflow/Skill Runtime;
- future Web Dashboard;
- other authorized control-plane clients.

The transport mechanism MAY be:

- event stream;
- resumable subscription;
- direct execution-status update;
- callback;
- bounded polling against the known execution ID.

The authoritative decision remains transport-independent.

### V3-EXEC-18 — Fast approval flow

The approval architecture SHALL support a low-friction human approval loop.

A representative flow is:

    caller invokes operation
      -> executionId returned/known
      -> Execution = WAITING_APPROVAL
      -> Operator shows pending approval
      -> user selects Allow
      -> Approval state persists
      -> original Execution resumes automatically
      -> completion state propagates

The user SHOULD NOT need to return to the initiating chat merely to type "approved" before execution can continue.

### V3-EXEC-19 — Approval Queue with execution context

The Local Operator SHOULD expose pending approvals as a queue/view linked to durable executions.

Each approval entry SHOULD provide enough context to identify:

- Runtime Slot;
- Workspace;
- execution ID;
- approval ID;
- capability/operation;
- purpose;
- approval reason;
- relevant scope/effect;
- expiry.

Resolving one Approval SHALL affect only the linked Execution unless an explicit persistent permission rule applies.

### V3-EXEC-20 — Same truth across approval and completion surfaces

Approval state and execution state SHALL not be separately inferred by different clients.

For one execution, Operator, remote caller and future UI surfaces SHOULD converge on the same authoritative sequence, for example:

    E123 WAITING_APPROVAL
    A456 ALLOWED
    E123 RUNNING
    E123 SUCCEEDED

This common state model is the basis for fast approval, reliable completion reporting and durable Audit correlation.

## 4. Relationship to existing V3 contracts

This requirement extends, rather than replaces:

- the common execution lifecycle;
- Permission / Approval;
- Audit / Recovery;
- Durable Run semantics;
- Runtime supervision;
- Managed Service Control;
- Core lifecycle / restart;
- Skill / Workflow Run semantics.

Conceptually:

    Client Call
        |
        v
    Invocation / Execution ID
        |
        v
    Permission
        |
        +---- allow -----------------------+
        |                                 |
        +---- confirm -> Approval ID       |
                          |                |
                    WAITING_APPROVAL       |
                          |                |
                    ALLOW / DENY           |
                          |                |
                          +------ allow ----+
                                           |
                                           v
                               Durable Execution State
                                           |
                    +----------------------+------------------+
                    |                      |                  |
                    v                      v                  v
             Local Process           Audit/Diagnostics   Completion/
             Service/Runtime                           Reconciliation
                                           |
                                           v
                              Client / Operator / Workflow

Transport is a view onto this lifecycle, not the owner of execution truth.

Approval is a durable authorization transition inside the lifecycle, not a request/retry protocol.

## 5. V2 observed scenarios motivating this requirement

### 5.1 Completion ambiguity

Observed V2 behavior:

    shell_run
        -> restart-related local command
        -> command disrupts Operator/control connectivity
        -> caller reports timeout
        -> host operation actually succeeds
        -> later activity_recent shows successful completion

This demonstrates that V2 already has useful Audit evidence, but the completion state is not returned/reconciled through a first-class operation contract.

### 5.2 Approval retry friction

Observed V2 approval interaction often requires:

    invoke
      -> approval_required
      -> Operator approval
      -> user returns to chat
      -> caller retries same request
      -> approved request is consumed
      -> execution finally starts

This works as a safety gate but introduces unnecessary interaction and creates two request attempts around one logical operation.

V3 SHOULD preserve the human authorization boundary while removing the retry choreography:

    invoke once
      -> WAITING_APPROVAL
      -> user approves in Operator
      -> same Execution resumes
      -> final completion propagates

The V3 requirement is therefore not "remove approval".

It is:

> make approval a durable, observable wait/resume state of the original execution.

## 6. Non-goals

This requirement does NOT mean:

- every operation must block until final completion;
- transport timeout values should simply be increased indefinitely;
- a caller disconnect should automatically cancel host work;
- all operations are safe to retry;
- Audit should be removed;
- lifecycle actions must stay inside the same process they restart;
- approval can be bypassed because a caller is waiting;
- Operator approval grants broader authority than the exact policy scope;
- all approvals become persistent permission rules.

## 7. Acceptance direction

V3 execution completion and approval design is not complete until the system can answer:

1. What execution did this request create?
2. Was it merely accepted, waiting for approval, running, or actually completed?
3. Did the caller stop waiting while execution continued?
4. Was the timeout transport-level or execution-level?
5. What is the current authoritative state?
6. Can the state be queried directly by execution ID?
7. Can the final state survive reconnect where appropriate?
8. If a restart broke the channel, did the replacement process actually become ready?
9. Is retry safe, duplicated, or reconciliation-required?
10. Can Operator and remote clients observe the same result without manually inferring it from recent activity?
11. Which approval governs this execution?
12. Can approval be resolved without requiring the caller to resubmit the same operation?
13. Does ALLOW resume the original execution?
14. Are DENY/EXPIRE/CANCEL represented explicitly?
15. Can approval changes propagate to authorized clients as state/events?
16. Can the user approve rapidly from the Operator while the original execution continues automatically?
