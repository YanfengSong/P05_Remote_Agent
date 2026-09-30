# Local Skill and Workflow engine

This module executes a finite declarative IR against controlled executors. It does not spawn a commercial Agent CLI, provide OS isolation, install skills from arbitrary files, or evaluate JavaScript/YAML expressions. The first implementation supports manual `start/status/tick/cancel`; it does not run a background scheduler. Calling `status` never advances work.

## Public interfaces

`WorkflowRegistry({ capabilities, agents? })` takes trusted dependency descriptors. Capabilities declare exact semantic version plus `read` or `write` effect. Provider descriptors also declare a revision and effect. Register definitions using `registerSkill`, `registerRoute`, then `registerWorkflow`. These return content digests. The same ID/revision cannot be changed to different content; register a new revision instead. `deactivateSkill(id, revision)` prevents new activations, while existing Runs retain their pinned snapshot.

`WorkflowEngine({ registry, state, executor, agents?, clock? })` exposes:

| Method | Contract |
|---|---|
| `start(context, {workflowId,revision,input,idempotencyKey,activationSource})` | Persist a new Run or return the identical previous intent. Does not execute nodes. |
| `status(owner, runId)` | Read a Run with principal and Slot ownership checks. |
| `tick(owner, runId)` | Advance only the current stage, up to bounded internal steps; dispatch independent branches, query existing invocations, or perform one registered stage handoff. |
| `cancel(owner, runId)` | Persist stop intent and propagate cancellation. Remain CANCEL_REQUESTED while any invocation is uncertain or cancellation is unconfirmed. |

All methods are asynchronous. `context` and `owner` come from authenticated server state, not arbitrary client arguments. Scope requires matching Workspace and security mode and a subset of the parent's authority. Skill discovery scope grants no permission. Executor adapters must enforce current authorization/revocation and the narrowed request scope before each effect. This foundation maps a `read` dependency to Read and `write` to WorkspaceWrite; capabilities with other authority models need a richer trusted effect descriptor before integration.

`StateBackend.read(namespace,key)` returns `{version,value}` or undefined. `compareAndSet(namespace,key,expectedVersion,value)` atomically creates on `expectedVersion === null`, otherwise updates only the matching version. Creation starts at version 1; each successful update increments the backend version by exactly one. Keys are caller-independent opaque hashes; namespace separates Workflow and provider state. The backend is trusted, local and durable; it must not expose arbitrary read/write to clients. Keep payloads protected outside the Workspace. Root's CoreState adapter is one possible implementation; tests use a real SQLite CAS table.

Acquire exclusive Core/Slot ownership before using an engine. Calls to tick/cancel within one engine are serialized per Run. Backend CAS detects competing ownership or unexpected writers; it is not a distributed lease. After losing CAS, the caller must reload and re-establish writer ownership, not force an update. External effects occur only after persisted invocation intent; a CAS failure after an executor acknowledgement can be recovered using the same executor idempotency key.

## Controlled executor and Agent provider

`ControlledExecutor` has `submit({context,capability,capabilityVersion,input,idempotencyKey})`, `status(context,executionId)` and `cancel(context,executionId)`, returning an `ExecutionSnapshot`. `submit` must durably deduplicate the key before effects and reject changed intent. It must acknowledge promptly rather than await the whole job. Status and cancel enforce ownership. `find(context,idempotencyKey)` is an optional read-only reconciliation entry for lost submission acknowledgements. Missing `find` prevents confirming cancellation of a submit whose ID is unknown; the engine retains CANCEL_REQUESTED rather than starting another action to cancel it.

An `AgentProvider` obeys the same contract with `providerId` and `revision`. Revisions are pinned in the saved definition and invocation. `CallbackAgentProvider` is a local trusted-code implementation for tests and integration. It persists an invocation before running the callback, deduplicates submissions, forwards abort, and records completion. After provider ownership is lost, a RUNNING callback without its in-memory executor becomes UNKNOWN and is never restarted automatically. `close()` aborts live callbacks and prevents late completion writes. It cannot restore arbitrary callback memory or prove an ignored abort stopped external effects. Its inputs and outputs are subject to the same payload confidentiality limits as the state backend.

The callback's Agent output is data. It cannot install a new plan, jump to an arbitrary stage, call an unregistered capability or grant itself permissions through this engine. An adapter that internally performs effects must enforce the controlled execution boundary itself; this library cannot sandbox arbitrary trusted callback code.
`CliAgentProvider` and `ProtocolAgentProvider` are real subprocess adapters for the same contract. The CLI adapter uses bounded JSONL over stdin/stdout; the protocol adapter uses bounded Node IPC. Before an Agent submit, WorkflowEngine creates an `agentPolicy` from the pinned Skill: exact allowed internal capabilities, remaining tool-call/iteration budget and the stage/workflow deadline. Child requests never carry authority; the parent adapter delegates only permitted tool calls to the P05 ControlledExecutor with the original narrowed Workflow context. Provider-reported usage is monotonic and is added to the Run budget; a provider that reports impossible usage fails closed. Claims such as “the user already approved” are non-authoritative data and do not alter the permit or context.

These subprocess adapters are currently `trusted-host` only. Sanitized environment and mediated tool RPC do not constitute filesystem/process/network isolation; `constrained-host` and `isolated-worker` requests are rejected until an enforceable backend is wired. Arbitrary Agent code that bypasses the protocol and uses OS APIs directly remains inside the trusted-host boundary and is not made safe by this adapter.

## Definition contracts

`SkillDefinition` includes ID/revision, owner/source/objective, bounded input/output schemas, scope, exact capability dependencies, Agent dependencies, budget, body, nonempty DoD rules and stop conditions. The supported schema subset is explicit object properties with `additionalProperties:false`, bounded arrays/strings, finite numbers, booleans and null. Missing contracts, unknown dependencies, duplicate node IDs, unreachable stages, unbounded stage cycles and invalid router targets fail registration.

Values are literal JSON or references to `input`, `last`, `iteration`, and previous-stage `results`, with a bounded own-property path. Conditions support equality, numeric ordering, and/or/not; no arbitrary code or expression strings. DoD rules require both a condition and resolvable evidence. Input/output schema validation and DoD must succeed before advancing. This provides automatic evidence contracts; external human judgment must be delivered through an explicitly trusted reviewer capability/provider, not inferred from an Agent's unstructured completion claim.

Nodes:

| Kind | Semantics |
|---|---|
| capability / agent | Persist invocation intent and pinned input, then dispatch/query a controlled executor. |
| sequence | Run children in order. `last` is the actual previous child's result. |
| condition | Persist the selected branch before executing it; the other branch stays inactive. |
| bounded-loop | Test `until` before each iteration; carry the previous iteration's output, persist iteration reservation and child intent together, stop at the declared bound. |
| parallel | Start independent branches without waiting for external completion, while respecting total in-flight budget. Output owners must be unique. |
| join | Require named results from the preceding parallel result and collect them explicitly. |
| verify | Check a finite condition and preserve declared evidence as output. |

Parallel write capabilities/providers are rejected until an enforceable work-isolation backend is available. Read branches receive only their declared authority intersection. Nested parallel branches share the overall in-flight limit. `cancel-siblings` propagates failure cancellation; `wait-all` waits for remaining branches before concluding failure. UNKNOWN branches require reconciliation and never imply completion.

A Workflow is a finite ordered graph of stages referencing fixed Skill revisions. Its edges reference registered Router definitions that identify source stage, target stage, target Skill revision and reason. Every stage must be reachable from the entry and no stage cycle is allowed; iteration belongs in bounded-loop nodes. Handoff transfers the actual validated previous-stage output, records the route/revision/reason, and activates only the target stage. It does not forward arbitrary history or expand scope.

## Persisted state and recovery

Each Run saves immutable context and activation source/reason, original input, a complete resolved definition snapshot and digest, Skill digests, provider revisions, active stage, iteration and call budgets, deadline, per-node selected branches and results, per-attempt invocation keys/IDs, artifact references, handoff records, and ordered events. Old definition revisions remain available inside the Run even if the next process registers a newer catalog.

An invocation intent is saved before submission. Reopening reads the existing execution ID and queries it. If submission acknowledgement was lost, resending the exact persisted key is permitted only because the executor contract durably deduplicates it; this is not a new action attempt. A known execution with UNKNOWN state is only queried again, never resubmitted. WAITING_APPROVAL stays at the original node and original execution. A FAILED invocation can retry only when the trusted executor explicitly returns `safeRetry:true` and the node's bounded `maxAttempts` permits it; the new attempt is recorded separately and consumes budget. The workflow never restarts completed stages to retry a later failure.

Budgets bound calls, iterations, in-flight parallelism, Workflow deadline and per-Skill deadline. Exhaustion requests cancellation of live children and remains CANCEL_REQUESTED until termination is confirmed; only then becomes BUDGET_EXHAUSTED. Cancellation never promises rollback. State is at most 4 MiB; event history retains the latest 2048 entries with original sequence numbers, so a first sequence greater than one indicates a retained-window gap. Invocation and node records remain authoritative. Unchanged polling does not append events or increment versions.

## Validation

`npx tsx src/test/v3-workflows.ts` runs a real SQLite-backed three-stage baseline → approved write → callback reviewer flow, closes/reopens both Workflow and durable execution state during approval, then confirms the original node resumes and the write occurs once. It also covers immutable revisions, ownership, missing contracts, invalid router handoff, scope escalation, inactive conditions, actual-result loops, parallel/join, unknown execution and cancellation, explicit safe retries, call/deadline exhaustion, and nonresumable callback recovery. This validates local contracts; it is not evidence of a commercial Agent integration or multi-host deployment.
