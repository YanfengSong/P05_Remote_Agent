# P05 V2 Deployment Hardening Plan

Status: APPROVED FOR IMPLEMENTATION  
Branch: `v2-deployment-hardening`  
Baseline: `7a8bf99`  
Scope: V2 deployment/core stabilization only

Implementation status:

```text
Phase 1  Runtime topology foundation        COMPLETE
Phase 2  Preflight / dependency check       COMPLETE
Phase 3  Network / proxy adaptation         COMPLETE
Phase 4  Core bootstrap verification        PENDING
Phase 5  Doctor                             POST-DEPLOYMENT
Phase 6  Operator health semantics          POST-DEPLOYMENT
```

## 1. Objective

Improve P05 fresh-machine deployment from "files installed" to "Core is actually usable" without turning Bootstrap into a full-system regression runner.

Deployment ends when the checked-out P05 source is valid, Core-required environment/dependencies are ready, a usable network path exists, the configured Core Runtime starts, and ChatGPT can reach the minimum Core MCP capability.

Target flow:

```text
git clone / checkout
  -> verify Git/source state
  -> bootstrap
  -> choose runtime slots
  -> preflight Core dependencies
  -> install/validate repo-local Core dependencies
  -> detect network path
  -> generate machine-local Core config
  -> generate configured runtime profiles
  -> build Core
  -> start configured Core Runtime
  -> verify Core health + minimum MCP capability
  -> P05 DEPLOYMENT READY
```

Core rule:

> Deployment owns the Core survival chain only. Optional applications, plugins, downstream MCPs and operator features must not block `P05 DEPLOYMENT READY`.

Deployment readiness is intentionally different from full-system health.

## 2. Deployment boundary

### In scope for one-click deployment

- valid Git worktree and known checked-out source revision;
- no unexpected tracked-source mutation caused by Bootstrap;
- configurable single/dual Runtime topology;
- Runtime A and B independently runnable;
- Windows/x64/PowerShell/Git preflight;
- repo-local Core dependency validation/install;
- Node/npm/tunnel-client required by Core;
- network/proxy detection and explicit network mode;
- machine-local `.env` and runtime profile generation;
- Core build;
- configured Core Runtime startup;
- Core health/readiness verification;
- minimum Core MCP verification such as `ping` / `device_info`;
- concise deployment report.

### Explicitly outside deployment success criteria

The following may have their own health/tests, but their failure MUST NOT change a healthy Core deployment into a deployment failure:

- MATLAB plugin;
- other application plugins;
- downstream MCP servers;
- plugin framework feature correctness;
- Git/FS/Execution plugin migration;
- Operator UI feature completeness;
- Doctor completeness;
- business workspace feature correctness;
- full V2 regression suite.

Also out of scope:

- V3 Component/Fiber runtime;
- plugin marketplace/dynamic registry;
- automatic firewall changes;
- automatic Windows system proxy changes;
- system service redesign;
- broad autonomous repair outside repo-local P05 installation.

## 3. Git/source integrity

Git is part of deployment provenance, not a proxy for full feature correctness.

Bootstrap/deployment must establish:

```text
valid Git worktree
known branch / HEAD commit
tracked source is not unexpectedly modified by deployment
build/runtime uses the checked-out source
```

A fresh clone naturally satisfies synchronization after checkout. For an existing worktree, deployment should report branch/HEAD and refuse or clearly diagnose unexpected tracked-source drift instead of silently overwriting source.

Bootstrap must not use plugin tests or application tests to prove that source is "good". Repository-wide regression remains a development/CI concern.

## 4. Runtime topology

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
- an unconfigured slot is `NOT_CONFIGURED`, not `OFFLINE`;
- only configured slots participate in deployment readiness.

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

Backward compatibility remains valid for installs created before `P05_RUNTIME_SLOTS`:

- valid A+B tunnel ids => infer `A,B`;
- only valid A => infer `A`;
- only valid B => infer `B` for runtime-control compatibility;
- invalid/ambiguous values => fail clearly.

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

Bootstrap preflight checks only prerequisites needed to build and run Core.

Checks:

```text
Windows / architecture
PowerShell
Git
repository validity
repo-local .p05 write ability
REMOTE_AGENT_ALLOWED_ROOTS
.env template
repo-local Node
repo-local npm
repo-local tunnel-client
```

Behavior:

- host/config failures block deployment;
- missing/broken repo-local Core dependencies are repairable;
- managed dependencies are revalidated after install;
- executable/version checks are real execution checks, not file-existence checks;
- checksum verification remains mandatory;
- optional plugins are not preflight requirements.

Status semantics:

```text
PASS        ready
REPAIRABLE  repo-local Core dependency can be repaired
FAIL        deployment prerequisite is invalid
```

## 7. Network model

Introduce:

```env
P05_NETWORK_MODE=auto
P05_PROXY=
```

Modes:

### auto

Probe direct connectivity first. If direct is unavailable, discover proxy candidates and select one only after a real connectivity probe succeeds.

Candidate sources may include:

```text
P05_PROXY
HTTPS_PROXY
HTTP_PROXY
Windows Internet Settings proxy
WinHTTP proxy
```

### direct

P05 Bootstrap and Core tunnel/control-plane access intentionally bypass proxies.

### proxy

`P05_PROXY` is mandatory and must be a valid HTTP/HTTPS proxy URI. An unavailable explicit proxy fails closed.

P05 MUST NOT automatically change Windows proxy settings.

Bootstrap downloads and Core Runtime must use the same selected network path.

## 8. Network diagnostics

Network failure must identify the failing class rather than emitting only a generic tunnel error.

Useful categories:

```text
DNS_FAILURE
TLS_FAILURE
DIRECT_CONNECT_FAILURE
PROXY_CONNECT_FAILURE
CONTROL_PLANE_REACHABLE
```

Never print API keys, Authorization headers, or proxy credentials.

## 9. Deployment health model

Deployment health is deliberately small and Core-only.

Conceptual shape:

```json
{
  "generatedAt": "...",
  "overall": "READY",
  "git": {},
  "environment": {},
  "network": {},
  "core": {
    "runtimeA": {},
    "runtimeB": {},
    "mcp": {}
  }
}
```

Deployment health inputs:

```text
Git/source state
Core prerequisite state
selected network path
configured Runtime process/readiness
Core MCP minimum capability
```

Deployment health MUST NOT include:

```text
plugin health
MATLAB health
downstream MCP health
Operator feature health
business workflow health
full regression status
```

Those belong to post-deployment diagnostics.

## 10. Deployment readiness semantics

Deployment states:

```text
READY
FAILED
```

Examples:

```text
A configured + Core ready
B NOT_CONFIGURED
minimum Core MCP PASS
=> READY
```

```text
A configured
Tunnel/Core Runtime cannot become ready
=> FAILED
```

```text
Core READY
MATLAB plugin broken
=> DEPLOYMENT READY
   optional capability unhealthy
```

```text
Core READY
Operator UI feature broken
=> DEPLOYMENT READY
   operator issue handled separately
```

Bootstrap must not equate "script completed" with deployment success, but it also must not expand success criteria beyond the Core survival chain.

## 11. Bootstrap final verification

Target output:

```text
P05 Deployment Report

Source
  Git Worktree          PASS
  Revision              <branch / commit>

Environment
  Git                   PASS
  Node                  PASS
  npm                   PASS
  Tunnel Client         PASS

Network
  Mode                  auto/direct/proxy
  Selected Path         direct/proxy
  Control Plane         PASS

Core
  Runtime A             PASS
  Runtime B             NOT CONFIGURED
  Core MCP              PASS

RESULT
  P05 DEPLOYMENT READY
```

Minimum Core MCP verification should use stable Core capabilities such as:

```text
ping
device_info
```

A deployment failure report should contain:

```text
FAILED LAYER
DIAGNOSIS
NEXT ACTION
```

No Plugin API, Plugin Framework, MATLAB, Downstream Smoke or Operator feature regression is required to print `P05 DEPLOYMENT READY`.

## 12. Post-deployment Doctor

Doctor is useful, but it is not part of one-click deployment success.

`scripts/deployment/doctor.ps1` may diagnose:

```text
Core config
Core dependencies
network path
runtime health
Core MCP health
plugin health
downstream MCP health
Operator health
recent failures
```

Doctor can distinguish:

```text
CORE FAILURE
OPTIONAL CAPABILITY FAILURE
OPERATOR FAILURE
```

An optional capability failure must not retroactively invalidate a healthy deployment.

## 13. Post-deployment Operator semantics

Operator remains an operational surface after Core deployment.

For an unconfigured slot:

- show `NOT CONFIGURED` instead of `OFFLINE`;
- disable invalid actions;
- do not count it as a Core failure.

Operator availability or UI feature correctness is not required for Bootstrap to declare Core deployment ready unless Operator itself is later explicitly promoted into the Core contract.

## 14. Implementation phases

### Phase 1 - Runtime topology foundation (P0)

1. Shared slot parser/helpers.
2. Add `P05_RUNTIME_SLOTS`.
3. Bootstrap default becomes single A.
4. Tunnel B becomes optional.
5. Generate state/profile only for configured slots.
6. Explicit refusal when controlling an unconfigured slot.
7. Legacy topology inference.

Acceptance:

```text
single A config          PASS
dual A+B config          PASS
A starts independently  PASS
B NOT_CONFIGURED in single mode
A/B independent in dual mode
```

### Phase 2 - Core preflight + dependency report (P0)

1. Extract reusable Core environment checks.
2. Validate managed tool versions after install.
3. Structured preflight result.
4. Actionable failures.
5. No optional plugin dependency may block preflight.

### Phase 3 - Network/proxy adaptation (P0)

1. Network mode parser.
2. Proxy candidate detection without Windows mutation.
3. Direct/proxy probes.
4. Persist selected repo-local network config.
5. Bootstrap downloads use selected network path.
6. Core tunnel process inherits the same selected path.

Phase 3 acceptance is network/Core-path specific. It does not require plugin, Operator or downstream regression suites.

### Phase 4 - Core bootstrap verification (P0)

1. Verify Git/source state.
2. Start configured Core Runtime slots.
3. Probe configured Runtime health/readiness only.
4. Verify minimum Core MCP capability.
5. Print final deployment report.
6. Stop at `P05 DEPLOYMENT READY`.

### Phase 5 - Doctor (post-deployment, P1)

1. Read-only diagnosis.
2. Core vs optional-capability classification.
3. Concrete next actions.

### Phase 6 - Operator health semantics (post-deployment, P1)

1. Preserve configured/unconfigured slot semantics.
2. Surface Core state clearly.
3. Surface optional capability state separately.
4. Never redefine deployment success.

## 15. Tests and acceptance

### Deployment-required tests

```text
runtime slot parser/config
single A bootstrap config generation
dual A+B bootstrap config generation
Core preflight
managed dependency repair/fail-closed behavior
network mode validation
proxy URI validation
direct network path
proxy fallback path
Bootstrap download uses selected network path
Core Runtime inherits selected network path
configured Runtime becomes ready
minimum Core MCP capability responds
Git/source remains consistent
```

### Development/CI tests, not deployment gates

```text
Plugin Framework
Plugin API v1
MATLAB plugin
Downstream Smoke
Operator feature regression
Output Schema regression beyond Core bootstrap contract
full repository verify suite
```

These remain valuable regression tests for development, but Bootstrap MUST NOT wait for or depend on them.

Fresh-machine testing on another Windows machine remains the final deployment acceptance because it validates the real deployment path.

## 16. Definition of Done

V2 one-click deployment hardening is complete when a fresh Windows machine can:

```text
git clone / checkout
-> identify the deployed Git revision
-> bootstrap
-> choose Single A (default) or Dual A+B
-> provide only credentials required by that topology
-> install/validate Core-managed dependencies
-> detect or diagnose network path
-> generate selected runtime profiles
-> build Core
-> start configured Core Runtime
-> verify Runtime readiness
-> verify minimum Core MCP capability
-> report P05 DEPLOYMENT READY
```

Mandatory default result:

```text
Git/source synchronized
Environment PASS
Network PASS
Runtime A PASS
Runtime B NOT_CONFIGURED
Core MCP PASS

=> P05 DEPLOYMENT READY
```

Explicit non-goals of this DoD:

```text
all plugins healthy
MATLAB healthy
all downstream MCPs healthy
Operator feature-complete
full V2 regression suite green
```

Those are separate post-deployment quality/operations concerns and must remain decoupled from the Core deployment contract.
