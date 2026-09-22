# P05 V3 Core Runtime Supervision Design

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Objective

Core supervises P05-owned optional runtime infrastructure without depending on it.

The primary supervised unit is the Optional Runtime Host, not each domain plugin implementation.

## 2. Ownership boundary

Core may control only processes/resources that have explicit P05 ownership metadata.

It MUST NOT kill or mutate arbitrary host processes merely because names match.

Ownership should include a durable runtime/slot identity plus current process identity where applicable.

## 3. Supervised state

Representative Optional Runtime state:

```text
disabled
starting
healthy
degraded
failed
backoff
crash_loop
stopping
```

Core status must remain readable even when the supervised process is absent.

## 4. Health model

Supervision combines:

- process existence;
- control-channel/heartbeat responsiveness;
- bridge API compatibility;
- optional readiness reported by the Runtime Host.

Process existence alone is not sufficient for HEALTHY.

Heartbeat failure is evidence of an unhealthy optional runtime, not Core failure.

## 5. Restart budget

Automatic restart MUST be bounded.

The supervisor maintains:

- consecutive failure count;
- failure timestamps;
- backoff;
- restart budget/window;
- last stable period.

When the budget is exceeded, state becomes `crash_loop` and automatic restart stops until:

- a cooldown/budget reset condition is reached; or
- an authorized operator explicitly retries.

Exact numeric defaults are implementation configuration, not architectural constants.

## 6. Safe restart

Restart sequence:

1. mark runtime unavailable for new optional routing;
2. request graceful stop when possible;
3. wait bounded drain;
4. terminate only the explicitly owned runtime process tree when necessary;
5. start a new instance;
6. wait for compatible control handshake;
7. publish new route generation;
8. mark healthy/degraded.

Unknown external processes are never terminated as part of cleanup.

## 7. Orphan handling

Core should detect P05-owned orphaned runtime instances using ownership metadata.

Recovery is conservative:

- verify ownership;
- exclude stale instance from routing;
- terminate/reap only if ownership is proven;
- otherwise report for human inspection.

## 8. Diagnostics

Supervisor diagnostics include:

- state;
- process/runtime instance id;
- start time;
- heartbeat age;
- restart count;
- crash-loop state;
- last failure category;
- bridge/API version;
- current route generation.

Raw secrets and unbounded logs are excluded.

## 9. Failure containment

SUP-01: Optional Runtime crash cannot terminate Core.

SUP-02: Event-loop hang in Optional Runtime is detected by heartbeat timeout.

SUP-03: Native crash is contained by process boundary.

SUP-04: Infinite restart loops are prevented by restart budget.

SUP-05: Supervisor itself failing to inspect optional runtime degrades status but does not remove Core recovery tools.

## 10. Acceptance

1. Kill Optional Runtime -> Core detects failure and stays online.
2. Hang Optional Runtime -> heartbeat marks unhealthy.
3. Repeated crash -> state reaches crash_loop and restart stops.
4. Manual retry after repair can start a fresh generation.
5. Stale/orphan runtime cannot silently receive new routed calls.

