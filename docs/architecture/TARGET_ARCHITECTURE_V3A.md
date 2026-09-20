# P05 Target Architecture V3-A — Execution & Agent Foundation

Status: implementation architecture baseline
Date: 2026-09-20
Parent target: TARGET_ARCHITECTURE_V3.md
Implemented baseline: Foundation V2 / P05 0.3.1
Target release: 0.4.x

## Purpose

V3-A is the first implementation slice of Architecture V3.

Its purpose is to make P05 safe to extend from a single interactive engineering session into concurrent, recoverable
Agent execution without redesigning Foundation V2 and without prematurely implementing Skill or Orchestrator layers.

V3-A freezes the following delivery boundary:

1. Execution Context.
2. Session Manager.
3. Process Driver abstraction.
4. Isolation Manager.
5. Agent Runtime plus one reference Agent Provider.

Verified Assets, Meta-Capabilities, Skills and Orchestrator remain V3 contracts, but they are not required for V3-A
completion.

## Architectural rule

Foundation V2 remains the stable substrate.

V3-A MUST extend:

- Workspace Registry;
- Capability Catalog;
- Policy;
- Execution Runtime;
- Audit / Recovery;
- Plugin Framework.

V3-A MUST NOT redefine those contracts merely to fit Agent execution.

The new execution path is:

```text
ChatGPT / MCP client
        |
        v
 Agent Runtime API
        |
        v
+-------------------------+
|    Execution Context    |
| workspace / actor       |
| session / isolation     |
| permissions / origin    |
+------------+------------+
             |
             v
+-------------------------+
|     Session Manager     |
| lifecycle / state       |
| events / recovery       |
+------+-------------+----+
       |             |
       v             v
 Process Driver   Isolation Manager
       |             |
       v             v
 Host Process     worktree/session root
       \             /
        \           /
         v         v
      Core Execution Runtime
 Policy / Execute / Verify / Audit
```

## 1. Execution Context

### Problem

Foundation V2 correctly uses one active Workspace for the interactive structured-tool surface.

That model MUST NOT become the identity model for concurrent Agents. A global
`WorkspaceManager.current()` value is mutable process-wide state; if Agent A and Agent B depend on it, switching the
interactive Workspace can change the authority or target of an already-running session.

### Contract

Every non-trivial asynchronous or long-lived execution MUST carry an immutable execution context.

Minimum target type:

```ts
type ExecutionContext = {
  executionId: string;
  workspaceId: string;
  actor: {
    type: "interactive" | "agent" | "plugin" | "system";
    id: string;
  };
  sessionId?: string;
  taskId?: string;
  isolation?: {
    kind: "workspace" | "worktree" | "session-root";
    root: string;
    sourceWorkspaceId: string;
  };
  authority: {
    profile: string;
    approvalState?: string;
  };
};
```

The exact TypeScript representation MAY change, but the semantics above are fixed.

### Rules

- Interactive tools MAY derive a context from the current Workspace at call start.
- A running Agent/Session MUST retain the context captured when it was created.
- Workspace switching MUST NOT mutate an existing Agent/Session context.
- File, Git, Process and plugin operations invoked for an Agent MUST resolve scope from its Execution Context.
- Execution Context MUST be data. It MUST NOT itself execute policy or grant authority.

## 2. Session Manager

### Definition

A Session is a recoverable logical execution container.

A Session is not synonymous with an OS process. One Session may own one or more host processes during its lifetime,
and future Session implementations may use a broker, container, remote worker or downstream service.

Minimum lifecycle:

```text
created -> starting -> running -> stopping -> completed
                      |    |
                      |    +-> failed
                      +------> interrupted
```

Minimum session record:

- stable session id;
- session kind;
- immutable Execution Context identity fields;
- lifecycle state;
- created/started/last-activity/finished timestamps;
- driver/provider identity;
- recovery classification;
- metadata-only persisted state.

### Ownership

Session Manager owns:

- lifecycle state;
- session lookup;
- event cursor semantics;
- bounded event retention;
- recovery classification;
- restart-time interruption handling;
- session-to-context association.

Session Manager MUST NOT contain:

- PowerShell command-line construction;
- `spawn`;
- Windows `taskkill`;
- Git worktree commands;
- Agent-provider prompt/CLI details.

Those belong to lower drivers/providers.

## 3. Process Driver

### Definition

Process Driver is a host execution adapter used by Session Manager.

Target interface shape:

```ts
interface ProcessDriver {
  start(request: ProcessStartRequest): Promise<ProcessHandle>;
  write(handle: ProcessHandle, input: ProcessInput): Promise<void>;
  stop(handle: ProcessHandle, mode: "graceful" | "force"): Promise<void>;
}
```

The handle exposes process events/state to Session Manager but does not decide Workspace authorization.

### Reference implementation

V3-A SHOULD provide `LocalPowerShellDriver` as the initial Windows implementation.

The current `src/process/runtime.ts` behavior is migration input, not the permanent architectural boundary.
PowerShell selection, `child_process.spawn`, stdin handling and `taskkill.exe` MUST move behind the driver boundary.

Future drivers MAY include:

- local executable driver;
- Approval/Execution Broker driver;
- restricted-account worker;
- container/VM worker;
- remote-device worker.

Adding a driver MUST NOT require changing Agent Runtime contracts.

## 4. Isolation Manager

### Purpose

Workspace authorization and write-collision isolation are different concerns.

Workspace answers "what project is authorized".
Isolation answers "what mutable work root belongs to this execution".

### Contract

Target API:

```text
allocate(context, mode)
inspect(allocation)
release(allocation)
reconcile(source, target)
```

Initial isolation modes:

- `workspace` — direct active/root use; intended for interactive/read-only cases.
- `worktree` — default for writing Agent Sessions in Git workspaces.
- `session-root` — reserved for future non-Git or generated working roots.

### Rules

- Concurrent writing Agents MUST NOT share one mutable checkout by default.
- A writing Agent on a Git Workspace SHOULD receive a dedicated worktree.
- Read-only Agents MAY share the source Workspace when policy allows.
- Isolation allocation MUST stay subordinate to Workspace authorization.
- A worktree is collision isolation, not an OS security sandbox.
- Reconciliation into the target Workspace MUST be explicit and auditable.

## 5. Agent Runtime

### Definition

Agent Runtime manages generic execution actors. Concrete Agents enter through Agent Provider Plugins.

Target public control surface remains:

```text
agent_list
agent_start
agent_task
agent_status
agent_output
agent_stop
agent_handoff
```

V3-A does not require every command above to be remotely exposed immediately. The internal contract comes first.

### Agent session contract

An Agent Session owns or references:

- agent session id;
- provider id;
- Execution Context;
- isolated work root;
- current task;
- lifecycle state;
- Session Manager session id(s);
- capability/permission context;
- output/event cursor;
- recovery state.

### Provider contract

A provider maps a concrete local Agent implementation to the generic Agent Runtime.

A provider MAY define:

- executable/transport startup;
- provider-specific task submission;
- provider-specific output decoding;
- graceful stop behavior;
- capability discovery.

A provider MUST NOT:

- grant itself extra Workspace authority;
- bypass Core Policy / Execution Runtime / Audit;
- choose an unauthorized work root;
- expose provider-specific command/path details as the generic Agent contract.

## 6. Plugin relationship

V3-A extends the existing Plugin Framework rather than creating a second extension mechanism.

The common plugin manifest remains the base contract.

Plugin classes become conceptually:

```text
Plugin
  +-- Application Plugin
  +-- Agent Provider Plugin
```

The manifest/API-version/dependency/lifecycle/permission model is shared.
Provider-specific fields belong to the Agent Provider extension, not to the base Application Plugin interface.

Core MUST boot and remain usable with zero Agent Provider Plugins.

## 7. Unified execution and audit

All execution still converges on Foundation V2 Core Runtime.

Target logical path:

```text
request
  -> build/capture ExecutionContext
  -> authorize capability + workspace + plugin/provider
  -> allocate isolation when required
  -> create Session
  -> driver/provider execution
  -> verify
  -> audit/recovery
  -> reconcile/release
```

Session lifecycle and Audit lifecycle are related but not identical:

- Session answers "what is the long-lived execution doing?"
- Audit answers "what authorized capability operation occurred?"

V3-A SHOULD create one shared identity/correlation model instead of making Process, Agent and future Skill runtimes
invent unrelated identifiers and recovery semantics.

Raw commands, prompts, source contents and terminal payloads MUST NOT be persisted merely for recovery metadata.
Existing metadata-only audit principles remain in force.

## 8. Migration from current Process Runtime

Current uncommitted Process Runtime proves useful behavior:

- command and terminal modes;
- stdin;
- incremental output cursor;
- wait;
- stop/force-stop;
- Workspace ownership check;
- metadata persistence;
- interrupted recovery.

These behaviors SHOULD be retained, but responsibilities are redistributed:

| Current responsibility | V3-A owner |
|---|---|
| Session id/lifecycle | Session Manager |
| Event cursor/buffer | Session Manager |
| Persisted session metadata | Session Manager/state store |
| Workspace identity | Execution Context |
| PowerShell spawn/args | LocalPowerShellDriver |
| stdin/kill/taskkill | LocalPowerShellDriver |
| work root selection | Isolation Manager |
| policy/audit wrapper | Core Execution Runtime |
| Agent command protocol | Agent Provider |

The current `ProcessRuntime` SHOULD therefore be treated as a reference prototype and migrated rather than expanded
into the Agent Runtime.

## 9. Source layout

Target V3-A source structure:

```text
src/
  runtime/
    context.ts
    execution.ts
    errors.ts

  session/
    types.ts
    manager.ts
    state.ts
    events.ts

  process/
    types.ts
    driver.ts
    drivers/
      local-powershell.ts

  isolation/
    types.ts
    manager.ts
    git-worktree.ts

  agent/
    types.ts
    registry.ts
    runtime.ts
    provider.ts
    session.ts

  plugin/
    types.ts
    registry.ts
    runtime.ts

  tools/
    register-process.ts
    register-agent.ts
```

Existing physical layout MAY migrate incrementally. Architectural ownership is more important than a one-shot
directory rename.

## 10. Delivery phases

### Phase A — Context boundary

- add Execution Context;
- preserve interactive active-Workspace behavior;
- allow runtimes to accept explicit context;
- prove Workspace switching cannot retarget captured execution.

### Phase B — Session / Process split

- create Session Manager;
- extract LocalPowerShellDriver;
- migrate current process tests;
- retain command/terminal/output/wait/stop behavior.

### Phase C — Isolation

- implement Git worktree allocation;
- bind process/session cwd to isolation root;
- define release and reconciliation records;
- prove two writing sessions do not share a checkout.

### Phase D — Agent Runtime

- add generic Agent contracts;
- add one reference Agent Provider;
- use Session Manager and Isolation Manager;
- make provider failure local and recoverable.

### Phase E — Stabilization

- integrate Audit correlation;
- restart/recovery tests;
- profile/capability exposure tests;
- documentation and compatibility review.

Only after Phase E SHOULD V3 implementation proceed to Verified Assets / Meta-Capabilities and then Skills.

## 11. Acceptance criteria

V3-A is complete only when all of the following are true:

1. Every Foundation V2 regression remains green.
2. Interactive Workspace switching behaves exactly as before for interactive structured tools.
3. A captured Agent/Session execution cannot be retargeted by later `workspace_switch`.
4. Two concurrent Agent Sessions can bind different registered Workspaces safely.
5. Two writing Agent Sessions on one Git Workspace receive different mutable work roots.
6. Process Session code has no direct dependency on PowerShell-specific spawn/kill implementation.
7. LocalPowerShellDriver can be replaced by another Process Driver without changing Agent Runtime contracts.
8. Agent Provider plugins cannot self-grant authority or bypass Core Runtime.
9. Session restart converts unrecoverable live state to explicit `interrupted` state.
10. Session/Agent operations correlate with the existing Audit/Recovery model.
11. Core boots with zero Agent Provider and zero Application plugins.
12. Existing Process Runtime functional behavior is preserved by migrated tests.
13. No parallel writing result is integrated without explicit reconcile/verification.
14. No Skill/Orchestrator implementation is required to satisfy the V3-A release.

## 12. Deferred to later V3 slices

V3-A intentionally defers:

- Verified Asset Registry;
- Meta-Capability promotion;
- Skill Contract/Registry/Runtime;
- Orchestrator task graph;
- parallel Skill branches/join;
- multi-device orchestration;
- GUI automation workers;
- hard OS sandboxing.

Those features depend on the execution/session/isolation contracts established here.

## Decision summary

P05 0.4.x SHOULD be an execution-foundation release, not a feature breadth release.

The key invariant is:

**A long-lived execution owns an immutable Execution Context and an isolated Session; it never depends on mutable
global Workspace state for its identity or target.**
