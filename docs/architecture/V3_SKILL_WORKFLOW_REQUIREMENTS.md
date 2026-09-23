# P05 V3 Skill / Workflow Requirements

Status: Accepted V3 requirement baseline
Scope: Skill / Workflow / behavioral orchestration
Purpose: formalize Skill and Workflow as first-class V3 requirements
Design input:
- AGENT-SKILL-ASSET-CONTRACTS.md
- ADR-0012-agent-skill-orchestrator.md
- TARGET_ARCHITECTURE_V3.md
- prior P05 workflow/behavior-standardization decisions

## 1. Objective

V3 SHALL provide a first-class Skill / Workflow system for reusable, bounded and auditable AI behavior.

The system must support more than executable code or application plugins.

A Skill may encode:

- a reusable engineering method;
- a behavioral contract;
- a review procedure;
- a development procedure;
- a validation procedure;
- a multi-step tool/agent workflow;
- a project-specific operating standard.

A Workflow coordinates multiple stages, Skills, Capabilities or Agents toward a defined objective and completion condition.

Core conceptual distinction:

    Skill
      = reusable bounded behavior / method / declarative workflow contract

    Workflow
      = controlled multi-stage execution flow with state, handoff and completion semantics

Skill and Workflow SHALL remain distinct from:

- Plugin Package;
- Component;
- Fiber;
- Capability;
- Agent;
- Asset;
- Workspace;
- Permission.

## 2. V3 Skill requirements

### V3-SKL-01 — Stable Skill identity and revision

Every Skill SHALL have a stable logical identity.

A Skill definition SHALL support at least:

- stable Skill ID;
- revision or version;
- description;
- owner/source;
- lifecycle state;
- compatibility metadata.

A changed Skill definition SHALL be traceable to a specific revision.

An in-flight Skill Run SHALL pin the Skill revision it started with.

### V3-SKL-02 — Declarative Skill contract

A Skill SHALL be representable as a declarative, inspectable contract.

The contract SHALL be able to describe:

- typed input;
- typed output;
- objective;
- preconditions;
- required Capabilities;
- optional Agent requirements;
- workflow steps/graph;
- DoD;
- approval points;
- retry/recovery behavior;
- budgets;
- stop conditions.

A Skill definition SHALL NOT require embedding arbitrary executable code as the primary workflow model.

Human-readable authoring SHALL be supported.

Markdown/YAML-style source MAY be used as an authoring format, while the runtime contract remains normalized and machine-readable.

### V3-SKL-03 — Complete behavior boundary

Every executable Skill SHALL define a complete behavior boundary.

At minimum it SHALL make explicit:

- what it may do;
- what it must not do;
- what inputs it expects;
- what output it produces;
- when it is complete;
- when it must stop;
- what constitutes a blocker;
- when human input/approval is required.

A Skill without an executable behavior contract SHALL NOT be activated as a live Skill.

### V3-SKL-04 — Capability-based requirements

Skill definitions SHALL depend on semantic Capabilities rather than hard-coded implementation details.

Preferred:

    requires:
      - capability: git.diff
      - capability: matlab.evaluate

Forbidden coupling examples include:

- direct dependency on one script filename;
- direct dependency on one executable path;
- direct dependency on one concrete Agent executable;
- direct dependency on one machine-specific absolute path unless explicitly modeled as configuration.

Binding selection belongs to the Capability/Runtime architecture.

### V3-SKL-05 — Agent requirements without provider lock-in

A Skill MAY require an Agent role or Agent capability.

It SHALL declare semantic requirements such as:

- reviewer;
- planner;
- implementer;
- verifier;
- required tool/capability set;
- required output contract.

It SHOULD NOT hard-code one Agent provider when an equivalent compatible provider can satisfy the requirement.

### V3-SKL-06 — Skill validation before activation

A Skill SHALL be validated before activation.

Validation SHALL cover at least:

1. input/output schemas;
2. graph reachability;
3. bounded loops;
4. required Capability compatibility;
5. Agent requirement compatibility;
6. approval requirements;
7. retry compatibility with effect class;
8. parallel writer isolation requirements;
9. output reachability;
10. DoD and stop-condition presence;
11. forbidden implementation coupling;
12. permission/security compatibility.

Invalid Skills fail closed.

### V3-SKL-07 — Skill scope

A Skill SHALL declare or resolve its scope.

Candidate scopes include:

- global/platform;
- project;
- Workspace;
- package/plugin;
- user-installed;
- session/run-local.

Scope controls discovery and applicability.

Scope does NOT grant execution authority.

### V3-SKL-08 — Project rules and behavioral rule injection

Skill execution SHALL support controlled injection of project-level behavior rules.

The architecture SHALL distinguish:

- platform/global behavior rules;
- project-specific rules;
- Skill-local rules;
- Workflow-stage rules.

Rule precedence SHALL be deterministic.

A Skill SHALL NOT silently override stronger platform security or authority rules.

### V3-SKL-09 — Skill activation and routing

The system SHALL support Skill selection through a routing mechanism.

Activation MAY occur through:

- explicit Skill request;
- explicit alias/command;
- Workflow handoff;
- automatic intent matching.

Explicit activation SHOULD take precedence over automatic matching.

Heavy or behavior-changing Skills SHALL require sufficient intent evidence before automatic activation.

Aliases and intent signals SHALL remain distinct concepts.

### V3-SKL-10 — Activated Skill as behavior contract

Once activated, a Skill SHALL act as a behavior contract for the relevant execution scope.

The runtime SHALL know:

- which Skill is active;
- which revision is active;
- which Run owns it;
- which rules are injected;
- which Capabilities are allowed/required;
- current Skill state;
- completion/stop conditions.

Activation MUST NOT silently broaden authority.

### V3-SKL-11 — Skill state and durable Run

Skill execution SHALL use durable Run semantics.

A Skill Run SHALL have:

- stable Run ID;
- Skill ID/revision;
- immutable ExecutionContext;
- parent/child lineage;
- state;
- event history;
- recovery status;
- trace correlation.

Skill state SHALL NOT exist only inside an ephemeral Component/Fiber.

### V3-SKL-12 — Skill audit and provenance

Skill execution SHALL be auditable.

Audit/provenance SHOULD record:

- Skill ID/revision;
- source/owner;
- activation source;
- parent Workflow/Run;
- Capability invocations;
- Agent child Runs;
- approvals;
- artifacts;
- final result;
- failure/recovery state.

The system SHALL be able to answer:

> Which Skill revision caused this action?

### V3-SKL-13 — Skill assets and installation lifecycle

A Skill MAY be distributed as a versioned Asset or as part of a Plugin Package/project source.

Presence does not equal activation.

The architecture SHALL distinguish:

- installed/available;
- enabled/eligible;
- active/running;
- deprecated/retired.

Skill update SHALL support revision tracking and migration/revalidation where required.

### V3-SKL-14 — Skill security integration

Skill metadata and requested permissions are declarations, not grants.

A Skill SHALL execute through the same:

- Execution Identity;
- Capability Effect Model;
- Permission Broker;
- Approval;
- Execution Boundary;
- Audit;

as other V3 executions.

A Skill SHALL NOT:

- self-authorize;
- widen Workspace authority;
- bypass Sandbox requirements;
- replace Policy;
- directly grant a Plugin/Agent more authority.

### V3-SKL-15 — Skill portability

Skill contracts SHOULD be portable across compatible Hosts and Agent providers.

Host-specific or tool-specific requirements SHALL be explicit compatibility constraints.

A Skill that requires Windows/MATLAB/ST-Link MAY declare that requirement.

The general Skill model SHALL NOT itself be Windows-, MATLAB- or provider-specific.

## 3. V3 Workflow requirements

### V3-WF-01 — Workflow as controlled Pipeline

V3 SHALL support composition of Skills, Capabilities and Agents into a controlled Pipeline.

A Workflow SHALL define:

- stages/nodes;
- ordering/dependencies;
- inputs/outputs;
- stage transitions;
- approval/wait points;
- failure/recovery semantics;
- completion semantics.

A Workflow SHALL NOT rely on hidden conversational convention for stage transitions.

### V3-WF-02 — Unified Workflow lifecycle contract

All executable Workflows SHALL follow a common lifecycle contract.

The contract SHALL define at least:

- initialization;
- activation;
- running;
- waiting;
- handoff;
- completion;
- failure;
- cancellation;
- interruption;
- recovery.

Workflow-specific semantics may extend this lifecycle but SHALL NOT replace it.

### V3-WF-03 — Current-stage activation

For staged Workflows, only the behavior contract of the current active stage SHOULD govern stage-specific execution.

Future-stage behavior SHALL NOT become active early merely because its definition is present.

Stage transition SHALL occur through an explicit lifecycle event or Handoff.

### V3-WF-04 — Controlled Handoff

Workflow stage transitions SHALL support a bounded Handoff contract.

Handoff SHOULD carry:

- source Run/stage;
- target stage/role;
- objective;
- context summary;
- Artifact/change references;
- unresolved items;
- constraints;
- required output;
- DoD.

Handoff SHALL NOT silently increase authority.

Full previous conversation history is not required as the default handoff mechanism.

### V3-WF-05 — Router-mediated Workflow switching

Workflow/Skill switching SHALL be coordinated through a common routing/lifecycle mechanism rather than direct uncontrolled invocation between Workflow modules.

A stage/Skill MAY request a Handoff.

The runtime/router decides the next compatible stage according to the declared Workflow contract.

This prevents hidden Workflow-to-Workflow coupling.

### V3-WF-06 — Workflow Registry

Executable Workflows SHALL be registered in a Workflow Registry or equivalent catalog.

Minimum metadata SHOULD include:

- stable Workflow ID;
- revision;
- description;
- aliases;
- intent signals;
- activation policy;
- required contract version;
- lifecycle state;
- entry stage;
- compatibility/scope.

Project-defined Workflows MAY be supported if they satisfy the same contract and registration rules.

### V3-WF-07 — Fail closed on missing behavior contract

If a Workflow/Skill is referenced but its required behavior contract is unavailable, invalid or incompatible, execution SHALL fail closed.

The runtime SHALL NOT invent missing Workflow behavior from naming convention alone.

### V3-WF-08 — Workflow session state

Workflow runtime state SHALL be explicit.

Session/Run state MAY include:

- active Workflow;
- active stage;
- active Skill;
- pending Handoff;
- waiting reason;
- retries;
- iteration count;
- unresolved blockers;
- produced Artifacts.

Ephemeral session state is distinct from project-controlled source truth.

### V3-WF-09 — Deterministic rule precedence

Workflow execution SHALL use deterministic rule precedence.

At minimum the architecture SHALL define the relationship among:

- platform invariants;
- security/policy;
- project rules;
- Workflow rules;
- Skill rules;
- stage-local rules;
- user task intent.

Behavior rules SHALL NOT override security authority.

Task intent and behavior standard are separate dimensions.

### V3-WF-10 — Bounded autonomous iteration

A Workflow MAY support autonomous multi-round iteration toward a DoD.

Each iteration SHALL use actual output/state from the previous iteration rather than replaying the original request blindly.

Autonomous iteration SHALL be bounded by explicit controls such as:

- DoD reached;
- maximum iteration count;
- budget exhausted;
- blocker detected;
- approval required;
- no meaningful progress;
- explicit cancel/stop.

The Workflow SHALL expose why it stopped.

### V3-WF-11 — Recovery and resume

A durable Workflow Run SHALL support controlled interruption/recovery.

After Runtime/Fiber/process interruption, the system SHOULD be able to determine:

- last durable stage;
- completed steps;
- pending external effects;
- waiting approvals;
- current artifacts;
- safe resume/reconcile point.

Non-idempotent external effects SHALL NOT be blindly replayed after uncertainty.

### V3-WF-12 — Parallelism and reconciliation

A Workflow MAY use parallel stages.

Parallel execution SHALL explicitly handle:

- mutable-root isolation;
- resource leases;
- output ownership;
- result reconciliation;
- conflict state;
- cancellation propagation.

Parallel writers SHALL NOT silently overwrite each other.

### V3-WF-13 — Workflow observability

The runtime SHALL expose enough Workflow state to answer:

- what Workflow is active;
- what stage is active;
- what Skill revision is running;
- what is waiting;
- what failed;
- what approvals are pending;
- what artifacts were produced;
- why the Workflow stopped.

### V3-WF-14 — Workflow cancellation

Workflow cancellation SHALL be explicit and propagated to owned child Runs where safe.

Cancellation SHALL distinguish:

- stopped local work;
- still-running external work;
- irreversible completed effects;
- resources requiring cleanup/reconciliation.

Cancellation is not equivalent to rollback.

## 4. Skill / Workflow relationship to other V3 concepts

### Plugin

Plugin is a package/distribution/ownership unit.

A Plugin MAY distribute Skills.

Plugin installation does not automatically activate those Skills.

### Component / Fiber

Component is a runtime composition unit.

Fiber is one live Component instance.

A Skill is not a Fiber.

A Skill Run may invoke services provided by Fibers, but Skill durable state survives Fiber replacement.

### Capability

Capability describes a semantic operation.

A Skill composes Capabilities.

A Skill SHALL prefer Capability contracts over concrete tool implementation.

### Agent

Agent is an execution actor.

A Skill MAY invoke an Agent according to semantic Agent requirements.

Agent Provider implementation details remain separate.

### Asset

A Skill definition MAY be represented/distributed as a versioned Asset.

Skill execution may consume Assets and produce Artifacts.

### Workspace

Workspace defines execution/work authority context.

Skill applicability may be Workspace-aware.

Skill scope/visibility is not Workspace authority.

### Permission

Skill permission declarations are requests.

All real execution still passes Policy/Permission/Approval.

## 5. Reference behavior model

Conceptually:

    User / Agent Intent
            |
            v
         Router
            |
      +-----+------+
      |            |
    DIRECT       Workflow
                   |
                   v
              Active Stage
                   |
                   v
                 Skill
                   |
          +--------+---------+
          |                  |
     Capability           Agent
          |                  |
          +--------+---------+
                   |
            Execution Boundary
                   |
              Audit / Run

## 6. Authoring direction

V3 SHOULD support human-readable Skill/Workflow source suitable for project-controlled use.

A project may therefore keep controlled definitions equivalent to:

    PROJECT_INDEX
    PROJECT_RULES
    WORKFLOW_INDEX
    skills/
    workflows/

Exact filenames and serialization are not frozen by this requirement.

The runtime representation SHALL nevertheless have:

- stable IDs;
- revisions;
- normalized fields;
- validation;
- deterministic precedence.

## 7. Relationship to P05 project behavior standardization

The Skill/Workflow system SHALL support P05's broader behavior-standardization use case:

- reusable Core protocol/invariants;
- modular Skills;
- explicit-first activation with automatic intent fallback;
- complete behavior boundaries;
- stop conditions;
- controlled Pipeline composition;
- stage Handoff;
- project-specific behavior rules;
- Project Instructions acting as minimal bootstrap/router where appropriate;
- controlled autonomous iteration toward DoD.

This behavior-standardization use case is a first-class requirement, not merely a prompt convention.

## 8. Non-goals

This requirement does not mean:

- every Skill must execute code;
- every Workflow must use multiple Agents;
- Skill source itself grants permissions;
- Markdown files are directly executable without validation;
- the router may infer heavy Workflow activation without evidence;
- Workflow cancellation can undo irreversible external effects;
- Plugin, Skill, Workflow, Agent and Component become one concept.

## 9. Acceptance direction

V3 Skill/Workflow design is not complete until the system can answer:

1. Which Skill/Workflow is this?
2. Which revision is active?
3. Why was it activated?
4. What scope/project does it apply to?
5. What behavior contract governs it?
6. What Capabilities/Agents does it require?
7. What authority does it actually have?
8. What stage/iteration is it in?
9. What is its DoD?
10. What makes it stop?
11. How does it hand off?
12. How is it recovered after interruption?
13. Which actions/artifacts came from it?
14. Can the same definition be validated before activation?
15. Can project-defined Skills/Workflows extend the system without bypassing Core security?
