# P05 Remote Agent — Tool Exposure Policy

Status: implemented and active
Foundation: V2
Updated: 2026-09-22

## Source of truth

Core capability metadata has one canonical source:

`src/capability/registry.ts`

Each core capability declares once:
- name;
- minimum profile;
- risk;
- scope;
- summary;

Application-plugin capabilities are declared in each plugin manifest and merged into the session `CapabilityCatalog`.

`src/policy/tool-profile.ts` computes profile decisions from the catalog. It is not a second capability registry.

## Profiles

Profiles are cumulative and unknown values fail closed.

| Profile | Implemented capabilities |
|---|---|
| discovery | `device_info`, `ping` |
| readonly | discovery + `workspace_list`, `workspace_current`, `reference_list`, `reference_read`, `reference_list_directory`, `activity_recent`, `recovery_status`, `plugin_list`, `fs_read`, `fs_list`, `git_status`, `git_diff`, `git_diff_stat` |
| developer | readonly + `fs_write`, `apply_patch`, `git_add`, `git_commit`, `git_branch`, `command_run`, `runtime_restart`, `mcp_status`, `mcp_list_tools` |
| full | developer + `shell_run`, `git_push`, `mcp_call_tool` |

## Workspace semantics

Readonly can inspect Workspace identity and authorization metadata without receiving host paths.

Workspace Binding is a human-controlled Runtime authority boundary. Remote MCP callers, including ChatGPT, cannot change the active Runtime Workspace. Rebinding is available only through the local Operator control path after explicit local user selection.

Structured Workspace capabilities are confined to the active Workspace:
- file read/list/write/patch;
- Git inspection and local mutation;
- Shell starting cwd.

An absolute structured path outside the Runtime's active Workspace is refused. A locally selected Operator Workspace replaces that Runtime's effective structured-tool root without changing another Runtime.

### Reference Roots

Reference Roots are Runtime-scoped, human-authorized, read-only directories outside the active Workspace.

Only the local Operator may add or remove a Reference Root. Remote MCP callers cannot grant themselves a new reference directory.

Remote read-only capabilities:
- `reference_list` — logical id/label only; host root paths are not returned;
- `reference_read` — text read inside one authorized Reference Root;
- `reference_list_directory` — direct-child listing inside one authorized Reference Root.

Reference Roots do not extend Workspace authority:
- `fs_write` / `apply_patch` remain Workspace-only;
- Git mutation remains Workspace-only;
- Shell cwd remains Workspace-only;
- MATLAB/downstream Workspace binding is unchanged;
- removing a Reference Root revokes authorization only and never deletes the host directory.

Reference Roots persist under the Runtime-specific P05 state directory, so Runtime A and Runtime B maintain independent reference authorization sets.

### Native HTTP Reviewer transport

P05 also provides an optional local Streamable HTTP MCP endpoint for external review clients.

Initial V2.x preview contract:
- entry: `npm run start:http-reviewer`;
- endpoint: `http://127.0.0.1:8765/mcp` by default;
- health: `http://127.0.0.1:8765/healthz`;
- local authentication: static Bearer token stored in the selected Runtime state directory;
- external OAuth preview: authorization-code flow with PKCE support, refresh tokens, Protected Resource Metadata and Authorization Server Metadata;
- OAuth client identity: fixed Reviewer client id/secret stored in the selected Runtime state directory;
- OAuth scope: only `p05.review`; clients cannot request a stronger P05 profile;
- default Runtime binding: slot B;
- fixed tool profile: `readonly`;
- active Workspace authority is reloaded from the selected Runtime state on each MCP request;
- the remote client cannot switch Workspace, grant Reference Roots, write files, execute Shell, mutate Git, or invoke MATLAB/downstream tools;
- a development Quick Tunnel may expose the local endpoint over temporary HTTPS for interoperability tests. Quick Tunnel URLs are ephemeral and are not a production deployment mechanism.

The HTTP transport is a Core transport surface, not a Gemini-specific plugin. Gemini or another MCP client may consume it; client-specific review orchestration can remain a plugin/provider concern.



Exactly one configured Workspace is `platform-source`; local Operator-selected business Workspaces may be bound independently per Runtime.

## Platform capability

`command_run(action)` is a platform capability, not an active-business-Workspace capability.

It always executes from the `platform-source` root.

Current server-side actions:
- `check`
- `build`
- `test_policy`
- `test_exposure`
- `test_foundation`
- `test_git_mutations`
- `smoke_downstream`
- `verify`

The MCP schema remains a single non-empty string. Executable, cwd and arbitrary args are not caller-controlled.

## Git mutation

### developer

`git_add`
- 1..200 explicit paths;
- active-Workspace confinement;
- Git pathspec magic refused.

`git_commit`
- local commit only;
- bounded nonblank message;
- does not silently bypass hooks.

`git_branch`
- create;
- switch;
- safe delete with `-d`;
- no force delete.

### full

`git_push`
- external mutation, therefore elevated;
- named remote only;
- current HEAD only;
- optional upstream setup;
- no force;
- no arbitrary refspec.

## Runtime authorization

Registration-time policy determines which tools are advertised.

Call-time policy is rechecked through the common Execution Runtime:
- prepare;
- authorize;
- execute;
- verify;
- complete/fail.

A call-time denial is classified as a `policy` failure in the `authorize` phase.

## Audit / Recovery

Readonly tools:
- `activity_recent`
- `recovery_status`

Audit is bounded and metadata-only. It does not store raw tool args, command text or file contents.

Persistent state is stored under the protected P05 state directory. A running record found after restart is converted to an `interrupted` failure.

Error categories:
- policy;
- timeout;
- process;
- tool;
- config;
- interrupted;
- unknown.

## Plugin / downstream model

`plugin_list` is readonly.

Application integrations use `src/plugin/*` and `src/plugins/*`.

Plugin capabilities are merged into the same session CapabilityCatalog.

Downstream MCP definitions can bind to:
- active Workspace;
- platform Workspace;
- fixed cwd.

A plugin-owned downstream is unavailable when the plugin is not permitted for the active Workspace.

MATLAB/Simulink is the first built-in application plugin.

## Shell

`shell_run` is not exposed at developer. It is available only at full.

Its starting cwd is technically confined to the active Workspace. The PowerShell
command itself retains the paired Windows user's OS permissions.

Therefore `shell_run` remains explicitly **not a sandbox**.

Moving shell to full is an immediate containment measure. Persistent
outside-Workspace modification still requires explicit user approval, and the
target design is to enforce that rule through a local approval/execution broker
or OS boundary rather than command-string filtering.

## Host authority

`runtime_restart` is developer-visible, but it is not a generic host execution
surface. It resolves the current Runtime slot and invokes the fixed repo-local
restart request:

    scripts/deployment/request-restart-runtime-slot.ps1 -Slot A|B

The MCP caller cannot supply an arbitrary command, script path, task name,
credential or elevation argument. The historical `P05-RestartBroker`
Scheduled Task is retired and is not required by the current Runtime path.

Other host/system mutations should continue to use explicit approval, narrow
external brokers, or stronger OS isolation rather than widening structured
developer tools.

## Planned capability layer

Foundation V2 should remain stable.

Next capabilities should plug into it:
- Process / persistent Terminal Sessions;
- asynchronous Search;
- richer Git convenience operations if needed;
- MATLAB/Simulink high-level adapters;
- multi-device;
- optional GUI / isolated worker.

## Verification

Canonical command:

    command_run(action=verify)

Current expected suites include:
- policy profile matrix;
- real MCP exposure tests;
- Foundation V2 tests;
- Git mutation tests;
- downstream MCP smoke test.

See `PROJECT_STATUS.md` for the latest verified counts.

## Architecture V3: Permission Profile vs Composition Profile

V3 introduces declarative Component Profiles/Bundles.

They are intentionally different from this Tool/Permission Profile.

### Permission / Tool Profile

Answers:

> What authority/tool exposure is available to the caller?

Examples:

- discovery;
- readonly;
- developer;
- full.

It is fail-closed and participates in authorization.

### Composition Profile

Answers:

> What Components/services should exist in this deployment or Context?

Example bundles:

- `p05/base`;
- `apps/matlab`;
- `agents/coding`;
- `ui/operator-console`.

Composition configuration may add/remove implementations, but it cannot elevate the active Tool/Permission Profile.

A deployment with a `matlab` Component loaded does not imply permission to execute every MATLAB Capability.
A `developer` Tool Profile does not imply that every optional Component is installed.

### Scoped presentation vs authority

A V3 Agent Context may restrict or shadow the model-visible tool/capability presentation.

Such scoped composition can narrow or change presentation/implementation.

It does not bypass call-time Core Policy.

The same Capability invocation remains subject to:

- ExecutionContext;
- Workspace;
- Tool/Permission Profile;
- Capability risk/effect class;
- Approval state;
- security execution mode.

### Source of truth rule

The semantic Capability Catalog remains canonical.

Dynamic Component/Fiber contributions provide/remove Capability Bindings and presentation layers.
They do not create a second independent policy registry.
