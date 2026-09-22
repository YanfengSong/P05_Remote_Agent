# P05 V3 Core Connection Design

Status: proposed Core sub-design
Parent: V3_CORE_CONTRACT.md

## 1. Objective

Connection is a permanent Core responsibility.

The objective is not to keep every transport alive at all times. The objective is to ensure that loss of one transport never destroys the Core control plane and that connection state is explicit, observable and recoverable.

## 2. Connection model

P05 distinguishes three layers:

1. Core MCP endpoint ? the stable AI-facing application endpoint.
2. Local transport ? stdio/local administrative access used to prove the Core itself is alive.
3. Remote connector ? tunnel/relay process used to expose the Core remotely.

Connection is a Core responsibility, but the remote connector MAY run as an external companion process. It is infrastructure, not a business plugin.

## 3. Required invariants

CONN-01: Local Core readiness does not depend on remote tunnel availability.

CONN-02: Remote tunnel failure does not stop the Core MCP server.

CONN-03: Core restart and remote connector restart are independently observable.

CONN-04: Reconnect attempts are bounded and use backoff; connection failure must not create a tight restart loop.

CONN-05: Authentication/session failure never falls back to an unauthenticated path.

CONN-06: Secrets/tokens are never returned through ordinary diagnostics or audit output.

CONN-07: Protocol incompatibility is reported as a compatibility error, not an unexplained disconnect.

## 4. Connection state

Core tracks connection state separately from Core mode.

Representative state:

```text
local:
  online | unavailable

remote:
  disabled | starting | connecting | online | backoff | failed

protocol:
  compatible | degraded | incompatible
```

Core mode remains `normal/degraded/recovery/locked`.

A remote outage normally changes connection state, not Core readiness.

## 5. Reconnect policy

Reconnect behavior MUST include:

- exponential or equivalent bounded backoff;
- maximum backoff cap;
- reset after a stable online period;
- explicit retry counter/last error;
- manual retry/restart path;
- crash-loop detection delegated to Runtime Supervision.

No transport may retry in a zero-delay loop.

## 6. Session and protocol compatibility

The Protocol Edge owns:

- MCP protocol negotiation;
- client capability negotiation;
- compatibility fallback where explicitly supported;
- connection-scoped trace/correlation metadata.

Protocol/session state MUST NOT become durable P05 application truth.

Reconnect may create a new MCP session while the same Core instance and local state remain authoritative.

## 7. Connection diagnostics

`core_status` SHOULD expose:

- local endpoint state;
- remote connector state;
- last successful remote connection time;
- last failure category;
- retry/backoff state;
- protocol compatibility state;
- remote connector version where available.

Diagnostics MUST avoid credentials and raw secret-bearing command lines.

## 8. Failure handling

Examples:

- tunnel offline -> Core stays ready; remote state becomes failed/backoff;
- remote authentication rejected -> no insecure fallback; report auth failure;
- incompatible connector/Core API -> isolate connector and report incompatibility;
- local MCP failure -> external process supervisor handles Core restart;
- connector crash loop -> supervisor disables automatic restart until budget recovers or operator intervenes.

## 9. Acceptance

1. Kill the remote connector; local Core remains responsive.
2. Restore connectivity; remote connector can reconnect without restarting Core.
3. Invalid credentials do not reduce security or expose secrets.
4. Protocol mismatch is diagnosable.
5. Repeated remote failures do not create an unbounded restart loop.

