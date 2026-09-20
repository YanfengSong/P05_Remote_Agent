# P05 Remote Agent — Tool Exposure Policy

Status: implemented and active
Foundation: V2
Updated: 2026-09-20

## Source of truth

Core capability metadata has one canonical source:

`src/capability/registry.ts`

Each core capability declares once:
- name;
- minimum profile;
- risk;
- scope;
- summary;
- optional gate.

Application-plugin capabilities are declared in each plugin manifest and merged into the session `CapabilityCatalog`.

`src/policy/tool-profile.ts` computes profile decisions from the catalog. It is not a second capability registry.

## Profiles

Profiles are cumulative and unknown values fail closed.

| Profile | Implemented capabilities |
|---|---|
| discovery | `device_info`, `ping` |
| readonly | discovery + `workspace_list`, `workspace_current`, `activity_recent`, `recovery_status`, `plugin_list`, `fs_read`, `fs_list`, `git_status`, `git_diff`, `git_diff_stat` |
| developer | readonly + `workspace_switch`, `fs_write`, `apply_patch`, `git_add`, `git_commit`, `git_branch`, `command_run`, `runtime_restart`, `mcp_status`, `mcp_list_tools`, `shell_run` |
| full | developer + `git_push`, `mcp_call_tool` |

Temporary gated migration capabilities:
- `list_directory`
- `read_file`

They appear only when `P05_TEMP_READONLY_ROOT` is configured.

## Workspace semantics

Readonly can inspect Workspace identity and authorization metadata without receiving host paths.

Developer can switch only by a registered logical Workspace id.

Structured Workspace capabilities are confined to the active Workspace:
- file read/list/write/patch;
- Git inspection and local mutation;
- Shell starting cwd.

An absolute structured path into another registered Workspace is refused even when both Workspaces are inside `REMOTE_AGENT_ALLOWED_ROOTS`.

Exactly one Workspace is `platform-source`.

## Platform capability

`command_run(action)` is a platform capability, not an active-business-Workspace capability.

It always executes from the `platform-source` root.

Current server-side actions:
- `check`
- `build`
- `test_policy`
- `test_exposure`
- `test_temp_readonly`
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

`shell_run` is available at developer.

Its starting cwd is technically confined to the active Workspace. The PowerShell command itself retains the paired Windows user's OS permissions.

Therefore `shell_run` is explicitly **not a sandbox**.

Persistent outside-Workspace modification still requires explicit user approval by operating policy unless an external broker pre-authorizes it.

Hard technical confinement requires an OS boundary or external execution broker.

## Host authority

`runtime_restart` is developer-visible but can only request the fixed external broker:

    schtasks.exe /Run /TN P05-RestartBroker

Host/system mutations should follow the same narrow external-broker / approval pattern rather than widening structured developer tools.

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
- temporary read-only tests;
- Foundation V2 tests;
- Git mutation tests;
- downstream MCP smoke test.

See `PROJECT_STATUS.md` for the latest verified counts.