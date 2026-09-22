# P05 V2 Deployment Hardening Plan

Status: APPROVED FOR IMPLEMENTATION  
Branch: `v2-deployment-hardening`  
Baseline: `7a8bf99`  
Scope: V2 stabilization only

Implementation status:

```text
Phase 1  Runtime topology foundation      COMPLETE
Phase 2  Preflight / dependency check     COMPLETE
Phase 3  Network / proxy adaptation       NEXT
Phase 4  Health / bootstrap verification  PENDING
Phase 5  Doctor                           PENDING
Phase 6  Operator health semantics        PARTIAL (topology semantics complete)
```

## 1. Objective

Improve P05 fresh-machine deployment from "files installed" to "deployment verified and diagnosable" without introducing V3 architecture changes.

Target flow:

```text
git clone
  -> bootstrap
  -> choose runtime slots
  -> preflight
  -> install/validate repo-local dependencies
  -> detect network path
  -> generate machine-local config
  -> generate only configured runtime profiles
  -> build
  -> health verification
  -> deployment report
```

Core rule:

> Required capabilities may block deployment. Optional capabilities must never be treated as failures merely because they are not configured.

## 2. V2 boundaries

In scope:

- configurable single/dual Runtime topology;
- Runtime A and B independently runnable;
- environment preflight;
- repo-local dependency validation/install;
- network/proxy detection and explicit network mode;
- deployment health model;
- bootstrap final verification;
- Doctor diagnostics;
- Operator awareness of unconfigured slots;
- deployment documentation and tests.

Out of scope:

- Git/FS/Execution plugin migration;
- V3 Component/Fiber runtime;
- plugin marketplace/dynamic registry;
- automatic firewall changes;
- automatic Windows system proxy changes;
- system service redesign;
- broad autonomous repair outside the repo-local P05 installation.

## 3. Runtime topology

Introduce one canonical setting:

```env
P05_RUNTIME_SLOTS=A
```

or:

```env
P05_RUNTIME_SLOTS=A,B
```

Rules:

- valid slot ids are `A` and `B` only;
- duplicates are rejected;
- fresh bootstrap default is `A`;
- `A,B` enables dual-runtime mode;
- Runtime A and B remain independently controllable;
- an unconfigured slot is `NOT_CONFIGURED`, not `OFFLINE`.

Interactive bootstrap:

```text
Runtime topology:
  1. Single Runtime (A) [default]
  2. Dual Runtime (A + B)
```

Single mode asks only for Tunnel A + API key. Dual mode additionally asks for Tunnel B.

Non-interactive examples:

```powershell
bootstrap.ps1 -RuntimeSlots A -TunnelA tunnel_xxx
bootstrap.ps1 -RuntimeSlots A,B -TunnelA tunnel_xxx -TunnelB tunnel_yyy
```

## 4. Backward compatibility

Existing installs without `P05_RUNTIME_SLOTS` remain valid.

Inference rules:

- valid A+B tunnel ids => infer `A,B`;
- only valid A => infer `A`;
- only valid B => infer `B` for runtime-control compatibility;
- invalid/ambiguous values => fail clearly / Doctor reports config failure.

Bootstrap writes `P05_RUNTIME_SLOTS` explicitly on new or updated deployments.

## 5. Profile/state generation

`write-runtime-profiles.ps1` MUST generate only configured slots.

Expected behavior:

```text
Slots=A
  -> runtime-a state/profile created
  -> runtime-b profile not required

Slots=A,B
  -> both state/profile sets created
```

Running an unconfigured slot must fail explicitly:

```text
Runtime B is not configured. Add B to P05_RUNTIME_SLOTS and run bootstrap again.
```

Starting/stopping/restarting one slot MUST NOT require or modify the other.

## 6. Environment preflight

Bootstrap runs preflight before runtime configuration.

Checks:

```text
Windows / architecture
PowerShell
Git
repository validity
repo-local .p05 write ability
repo-local Node
repo-local npm
repo-local tunnel-client
.env readiness
allowed-root configuration
```

Behavior:

- Git is detected and reported as a prerequisite;
- managed Node/npm and tunnel-client are installed automatically unless skipped;
- versions and executables are revalidated after install;
- checksum verification remains mandatory;
- Bootstrap and Doctor reuse the same check functions/results.

## 7. Network model

Introduce:

```env
P05_NETWORK_MODE=auto
P05_PROXY=
```

Modes:

### auto

Discover candidates and select a path only after a real connectivity probe succeeds.
Candidate sources include existing `HTTPS_PROXY` / `HTTP_PROXY`, explicit `P05_PROXY`, Windows proxy settings, and direct connection.

### direct

P05 tunnel/control-plane access intentionally avoids proxy configuration.

### proxy

`P05_PROXY` is mandatory and must be a valid HTTP/HTTPS proxy URI.

P05 MUST NOT modify Windows proxy settings automatically.

## 8. Network diagnostics

Classify failures rather than emitting only a generic tunnel error.

Useful result categories:

```text
DNS_FAILURE
TLS_FAILURE
DIRECT_CONNECT_FAILURE
PROXY_CONNECT_FAILURE
CONTROL_PLANE_REACHABLE
```

Never print API keys, Authorization headers, or secret environment values.

## 9. Shared health model

Bootstrap, Doctor and Operator should converge on one health model.

Conceptual shape:

```json
{
  "generatedAt": "...",
  "overall": "ready",
  "environment": {},
  "network": {},
  "slots": {
    "A": {},
    "B": {}
  },
  "operator": {}
}
```

`status.json` may exist only as a timestamped snapshot. Live probes remain the truth source.

Live inputs:

```text
configuration
process state
health URL
/healthz
/readyz
local control bridge
tunnel status/log category
```

## 10. Overall state semantics

Overall states:

```text
READY
DEGRADED
FAILED
```

Examples:

```text
A = ONLINE
B = NOT_CONFIGURED
=> READY
```

```text
A = ONLINE
B = configured but failed
=> DEGRADED/FAILED according to requested deployment target
```

Bootstrap must not equate "script completed" with "P05 ready".

## 11. Bootstrap final report

Target output:

```text
P05 Deployment Report

Topology
  Runtime Slots       A

Environment
  Git                 PASS
  Node                PASS
  npm                 PASS
  Tunnel Client       PASS

Network
  Mode                auto
  Selected Path       direct/proxy
  Control Plane       PASS

Runtime
  Runtime A           PASS
  Runtime B           NOT CONFIGURED

MCP
  Runtime A           PASS

Operator
  Console             PASS / NOT STARTED

RESULT
  P05 READY
```

On failure print:

```text
FAILED LAYER
DIAGNOSIS
NEXT ACTION
```

## 12. Doctor

Add:

```text
scripts/deployment/doctor.ps1
```

Initial V2 behavior is read-only diagnosis:

```text
detect
-> diagnose
-> recommend
```

Checks include config, slots, managed tools, network path, profiles, Runtime health, bridge/MCP health and recent tunnel failure category.

Do not begin with broad automatic repair. Later, only narrow repo-local repairs may be added.

## 13. Operator changes

Operator must understand configured vs unconfigured slots.

For an unconfigured slot:

- show `NOT CONFIGURED` instead of `OFFLINE`;
- disable start/restart/workspace controls;
- do not count it against overall health.

Configured A/B keep the current independent control model.

## 14. Implementation phases

### Phase 1 - Runtime topology foundation (P0)

1. Shared slot parser/helpers.
2. Add `P05_RUNTIME_SLOTS` to `.env.example`.
3. Bootstrap default becomes single A.
4. Tunnel B becomes optional.
5. Generate state/profile only for configured slots.
6. Explicit refusal when controlling an unconfigured slot.
7. Legacy dual-runtime inference.

Acceptance:

```text
single A config          PASS
dual A+B config          PASS
A starts independently  PASS
B NOT_CONFIGURED in single mode
A/B independent in dual mode
```

### Phase 2 - Preflight + dependency report (P0)

1. Extract reusable environment checks.
2. Validate managed tool versions after install.
3. Structured preflight result.
4. Better actionable errors.

### Phase 3 - Network/proxy adaptation (P0)

1. Network mode parser.
2. Proxy candidate detection without Windows mutation.
3. Direct/proxy probes.
4. Persist selected repo-local network config.
5. Verify tunnel process receives selected proxy environment.

### Phase 4 - Health + bootstrap verification (P0/P1)

1. Shared health result model.
2. Probe configured slots only.
3. Final deployment report.
4. Optional `.p05/status.json` snapshot.

### Phase 5 - Doctor (P1)

1. `doctor.ps1` reusing shared checks.
2. Failure classification.
3. Concrete next actions.

### Phase 6 - Operator topology/health semantics (P1)

1. Expose `configured` per slot.
2. Render `NOT CONFIGURED`.
3. Disable invalid actions.
4. Surface useful health/network summary.

## 15. Tests

Required tests include:

```text
slot parser A
slot parser A,B
slot parser B
invalid/duplicate slots
single bootstrap config generation
dual bootstrap config generation
single profile generation
dual profile generation
unconfigured slot refusal
legacy topology inference
network mode validation
proxy URI validation
health ignores unconfigured slot
health fails configured broken slot
Doctor classification
Operator NOT_CONFIGURED behavior
```

Fresh-machine testing on another Windows machine remains the final deployment acceptance.

## 16. Definition of Done

V2 deployment hardening is complete when a fresh Windows machine can:

```text
git clone
-> bootstrap
-> choose Single A (default) or Dual A+B
-> provide only credentials required by selected topology
-> install/validate managed dependencies
-> detect or diagnose network path
-> generate only selected runtime profiles
-> build
-> verify the full configured chain
-> report READY or the exact failing layer
-> show the same topology/diagnosis in Operator/Doctor
```

Mandatory default result:

```text
Runtime A configured and healthy
Runtime B NOT_CONFIGURED
=> P05 READY
```