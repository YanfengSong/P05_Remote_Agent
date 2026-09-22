# P05 V3 Core Resource Guard Design

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Objective

Core must remain responsive under malformed, slow, excessive or failing work.

Resource protection is a Core responsibility because one request must not be able to consume the control plane itself.

## 2. Protected resources

Core protects at minimum:

- concurrent MCP invocations;
- request body/input size;
- output/structured-result size;
- execution time;
- forwarded Optional Runtime calls;
- diagnostic/log retention;
- audit storage growth;
- restart/retry activity;
- in-memory route/health metadata.

## 3. Concurrency and backpressure

Core MUST have bounded concurrency.

When capacity is exhausted it should:

- queue within a bounded limit where appropriate; or
- reject immediately with a structured busy/backpressure error.

Unbounded queues are forbidden.

Core recovery operations MAY receive reserved capacity so that a flood of optional calls cannot make repair tools unavailable.

## 4. Timeout and cancellation

Every operation with external/process/bridge interaction requires a bounded timeout or explicit long-running contract.

Cancellation should propagate to Optional Runtime when supported.

Timeout of one request does not cancel unrelated work or restart Core.

## 5. Output limits

Core enforces bounded:

- stdout/stderr capture;
- file read/write payloads;
- tool result sizes;
- forwarded result sizes;
- diagnostic log tails.

Truncation must be explicit.

Large retained artifacts belong outside the Core response path.

## 6. Optional Runtime circuit protection

Repeated Optional Runtime failures may trip a circuit-breaker-like state:

- stop routing new optional calls;
- report runtime unavailable/degraded;
- allow Core recovery/supervision calls;
- retry only under supervisor policy.

This prevents failure storms from consuming Core capacity.

## 7. Diagnostic and audit durability

Audit/diagnostic persistence uses bounded retention.

Failure to persist non-critical diagnostics may degrade observability but must not block the Core event loop indefinitely.

Security-critical authorization decisions must fail closed if their required authoritative state cannot be evaluated.

## 8. Core priority classes

Conceptual priority:

1. liveness/status;
2. security/approval decisions;
3. recovery/supervision;
4. ordinary Core read operations;
5. optional routed work.

Implementation may use separate limits rather than a scheduler, but optional work must never starve liveness/recovery.

## 9. Host resource limits

Hard memory/CPU/process limits, when required, are best enforced by the external process supervisor/OS boundary rather than assumed to be enforceable by application code alone.

Core reports such limits/status where available.

## 10. Resource invariants

RES-01: No unbounded request queue.

RES-02: No unbounded tool output accumulation.

RES-03: Optional routed work cannot starve Core health/recovery endpoints.

RES-04: One hung downstream call cannot block unrelated Core requests.

RES-05: Restart/reconnect loops are rate-limited.

RES-06: Diagnostic retention is bounded.

RES-07: Resource limit failure returns an explicit error and does not broaden authority.

## 11. Acceptance

1. Flood optional calls -> ping/core_status remain responsive.
2. Downstream call hangs -> timeout fires; other Core calls continue.
3. Oversized output -> bounded/truncated or rejected explicitly.
4. Audit/log volume remains bounded.
5. Repeated connector/runtime failures do not consume unlimited restart capacity.

