# P05 Plugin API v1 Technical Design

Status: IMPLEMENTED  
Branch: `plugins`  
API version: `1`  
Scope: Foundation V2 private / first-party plugin runtime

Related documents:

- `PLUGIN-FRAMEWORK.md` — long-term architecture and V3 evolution
- `PLUGIN_DEVELOPMENT_STANDARD.md` — plugin authoring rules and Definition of Done

## 1. Purpose

This document describes the implemented Plugin API v1 runtime in engineering terms.

It answers four questions:

1. how a plugin enters P05;
2. how its capabilities and tools are validated and exposed;
3. how P05 keeps Workspace, Profile and downstream authority in Core;
4. how a real application plugin such as MATLAB/Simulink uses the framework.

This is an implementation document for the current V2 runtime. It is not the V3 Component/Fiber target design.

## 2. Design goals

Plugin API v1 exists to keep application-specific behavior outside P05 Core while preserving Core-owned authorization.

The design MUST provide:

- stable plugin identity and API versioning;
- declarative capabilities and tools;
- explicit source-controlled registration;
- Workspace-aware activation;
- Profile / capability authorization through Core;
- downstream MCP ownership;
- plugin failure isolation;
- no plugin-specific import in Core;
- no arbitrary downloaded-code loader.

The design intentionally does NOT provide:

- a public plugin marketplace;
- arbitrary runtime JavaScript loading;
- plugin self-authorization;
- typed generic plugin configuration;
- generic first-class Skill / Asset contribution APIs;
- V3 Component/Fiber hot replacement.

## 3. Source layout

```text
src/plugin/
├─ api.ts          Public Plugin API v1 surface
├─ types.ts        Stable v1 contracts
├─ registry.ts     Static validation + contribution index
└─ runtime.ts      Runtime state + guarded exposure

src/plugins/
├─ catalog.ts      Source-controlled plugin catalog
├─ builtins.ts     Boot-path compatibility assembly
├─ example/
└─ matlab/

src/test/
├─ plugin-framework.ts
├─ plugin-api-v1.ts
└─ matlab-plugin-v1-live.ts
```

Core consumes the plugin catalog through the framework boundary. Application-specific imports are kept under `src/plugins/*`.

## 4. Boot and registration flow

The implemented flow is:

```text
P05 boot
  -> LOCAL_PLUGINS
  -> PluginRegistry
       -> validate manifest
       -> validate API version
       -> validate capabilities
       -> validate tools
       -> validate dependencies
       -> collect downstream definitions
  -> PluginRuntime
       -> create initial runtime state
       -> register guarded tools
       -> start enabled plugins
  -> MCP exposure
```

The local catalog is explicit:

```ts
export const LOCAL_PLUGINS = [
  matlabPlugin,
  examplePlugin
];
```

This is intentional. P05 does not scan directories and does not execute arbitrary plugin paths.

## 5. Public Plugin API v1

The public entry point is:

```text
src/plugin/api.ts
```

It exports the v1 contracts and helper functions:

```text
PLUGIN_API_VERSION
definePlugin()
defineTool()
defineDownstream()
pluginResult()

PluginManifest
PluginContext
PluginToolDefinition
PluginDependency
PluginPermissionDeclaration
PluginWorkspaceSnapshot
DownstreamDefinition
CapabilityDescriptor
```

New plugins should import through this file instead of importing Core implementation modules.

The helpers are declarative identity helpers. They do not mutate global state, auto-register plugins or grant authority.

## 6. Plugin manifest contract

Each plugin declares a manifest with:

```ts
{
  id,
  label,
  version,
  apiVersion,
  enabled,
  capabilities,
  permissions,
  dependencies?
}
```

Important invariants:

- plugin id must match `[a-z0-9][a-z0-9._-]{0,63}`;
- `apiVersion` must equal the supported Plugin API version;
- plugin ids must be unique;
- capability names must use the `<plugin-id>.` prefix;
- duplicate capabilities fail closed;
- declarative tool names must use the same plugin prefix;
- every declarative tool must have a matching manifest capability;
- `hostEffects=none` cannot declare host/external capabilities.

These checks are performed before runtime use by `PluginRegistry`.

## 7. Capability and authorization model

A plugin can declare capability requirements, but declaration is not authorization.

The effective call path is:

```text
MCP tool call
  -> Core exposure / Profile gate
  -> PluginRuntime workspace gate
  -> plugin handler
  -> optional downstream ownership gate
  -> downstream MCP
```

Authority stays in P05 Core.

A plugin MUST NOT bypass:

- Tool Profile;
- Capability metadata;
- active Workspace policy;
- downstream ownership;
- Core policy/exposure semantics.

This separation is important:

```text
plugin declares what it needs
Core decides whether it may run
```

## 8. Workspace model

`PluginContext.workspace` exposes a read-only view:

```ts
context.workspace.current()
context.workspace.root()
```

The snapshot contains:

```text
id
root
kind
label?
platform
```

A plugin can be globally installed/enabled but unavailable in the current Workspace.

Runtime tool invocation re-checks Workspace eligibility. Registration alone does not imply that a later call is allowed.

This prevents stale activation state from becoming authorization.

## 9. Declarative tool model

Plugin API v1 tools use `defineTool()`.

A tool may declare:

```text
name
description
inputSchema
outputSchema
handler
```

Handlers receive:

```ts
handler(args, context)
```

The runtime registers each declarative tool through the Core exposer and wraps its handler with a Workspace permission check.

Structured results should use:

```ts
pluginResult(...)
```

which maps plugin output to the standard P05 structured MCP result shape.

The legacy imperative `registerTools()` hook still exists only for backward compatibility. New v1 plugins should use declarative `tools[]`.

## 10. Downstream MCP ownership

A plugin may contribute downstream MCP definitions.

The Registry associates each contributed downstream with the owning plugin.

At runtime, `PluginContext.downstream` exposes:

```ts
listTools(serverId)
callTool(serverId, tool, args)
```

Before either operation, PluginRuntime checks that the requested downstream id belongs to the calling plugin.

Therefore:

```text
Plugin A -> Downstream A    allowed
Plugin A -> Downstream B    rejected
```

A plugin cannot use PluginContext as a general-purpose bridge to another plugin's downstream server.

Workspace binding for a downstream remains part of the downstream definition and Core runtime behavior.

## 11. Lifecycle model

Current Plugin API v1 runtime states are:

```text
disabled
ready
running
failed
stopped
```

Initialization behavior:

```text
enabled=false -> disabled
enabled=true  -> ready
```

`startAll()` starts enabled plugins independently.

If one plugin throws during `start()`:

- that plugin moves to `failed`;
- the error is recorded;
- startup of other plugins continues.

This provides failure isolation.

`stopAll()` invokes plugin stop hooks independently and transitions enabled plugins to `stopped`.

The lifecycle context is deliberately small in v1. Plugins that need richer long-running resource ownership are a future API pressure point and are expected to move toward the V3 Component/Fiber model.

## 12. Dependency handling

Plugins may declare plugin dependencies.

Registry construction validates the declared dependency graph before normal runtime use.

Dependencies are package/plugin-level V2 contracts. They are not the final V3 service-composition model.

V3 is expected to replace coarse plugin startup dependency semantics with typed Component service requirements.

## 13. Catalog and trust boundary

The only current installation mechanism is the source-controlled local catalog:

```text
src/plugins/catalog.ts
```

Properties:

- reviewed code only;
- compiled with P05;
- no directory scanning;
- no remote package execution;
- no arbitrary path supplied by a caller;
- auditable registration diff.

This means Plugin API v1 is a private / first-party extension system, not a sandbox for untrusted third-party code.

## 14. MATLAB / Simulink reference implementation

MATLAB is the first complex plugin migrated to Plugin API v1.

Source:

```text
src/plugins/matlab/plugin.ts
src/plugins/matlab/skills.ts
```

The plugin contributes three public tools:

```text
matlab.call_tool
matlab.skill_list
matlab.skill_read
```

It also contributes the MathWorks MATLAB MCP downstream.

### 14.1 Discovery

By default it discovers the MathWorks Agentic Toolkit under:

```text
~/.matlab/agentic-toolkits
```

It resolves:

- MATLAB MCP executable;
- optional Simulink extension;
- MathWorks MATLAB/Simulink skill assets.

Explicit environment configuration may override discovery.

### 14.2 Workspace binding

MATLAB downstream supports:

```text
active
platform
fixed
```

For the normal application-plugin path, `active` binds execution to the active P05 Workspace.

### 14.3 Path protection

Before forwarding MATLAB arguments, the plugin guards path-like fields including:

```text
model
*_path
```

Resolved/canonical paths must remain inside the active Workspace.

Parent traversal and paths that resolve outside the Workspace are rejected before downstream execution.

### 14.4 Downstream execution

`matlab.call_tool` performs:

```text
P05 tool authorization
  -> plugin Workspace check
  -> argument path guard
  -> downstream ownership check
  -> MathWorks MCP call
```

For `evaluate_matlab_code`, the active Workspace is supplied as `project_path` when not explicitly provided.

### 14.5 Skill assets

`matlab.skill_list` and `matlab.skill_read` expose installed MathWorks `SKILL.md` content as read-only plugin assets.

These are guidance assets supplied by MathWorks. They are not P05 V3 executable Skills and do not implement generic `skill_run` semantics.

## 15. Failure model

The v1 failure model is fail-closed at contract boundaries and isolated at plugin startup boundaries.

Examples:

```text
invalid plugin id                  -> Registry construction fails
wrong Plugin API version           -> Registry construction fails
duplicate plugin id                -> Registry construction fails
tool without capability            -> Registry construction fails
invalid capability prefix          -> Registry construction fails
Workspace not allowed              -> invocation rejected
foreign downstream access          -> invocation rejected
plugin start exception             -> plugin FAILED, others continue
MATLAB path escapes Workspace      -> invocation rejected
```

Optional plugin failure must not redefine Core deployment readiness.

## 16. Observability

Current runtime inspection is available through the PluginRuntime view.

Each plugin view reports:

```text
id
label
version
apiVersion
enabled
state
activeForWorkspace
capabilityNames
downstreamIds
lastError?
```

This is sufficient for current v0.1 inspection.

Dedicated plugin diagnostics/health contribution is not yet a frozen API.

## 17. Test architecture

Three test layers currently define the v1 acceptance boundary.

### 17.1 Framework contract

```text
src/test/plugin-framework.ts
```

Covers registry validation, Workspace gating, failure isolation, MATLAB contribution shape and related framework invariants.

Current verified result:

```text
PLUGIN_FRAMEWORK_OK (32 checks)
```

### 17.2 Public API smoke

```text
src/test/plugin-api-v1.ts
```

Runs a real P05 MCP process and verifies the Example Plugin through the public MCP surface.

Current verified result:

```text
PLUGIN_API_V1_OK (4 checks)
```

### 17.3 Real MATLAB pressure test

```text
src/test/matlab-plugin-v1-live.ts
```

Uses the locally installed MathWorks Agentic Toolkit / MATLAB MCP stack.

It verifies:

```text
declarative MATLAB tools exposed
real MathWorks skill catalog
skill content read
real downstream tool discovery
Workspace escape rejection
real MATLAB execution
plugin running state
downstream ownership
```

Current verified result:

```text
MATLAB_PLUGIN_V1_LIVE_OK (8 checks)
```

## 18. Plugin API v1 Definition of Done

The implemented v1 framework is complete when:

```text
Public API boundary             PASS
Manifest validation             PASS
API version validation          PASS
Capability validation           PASS
Declarative tool registration   PASS
Profile/Core exposure gate      PASS
Workspace gate                  PASS
Downstream ownership            PASS
Lifecycle failure isolation     PASS
Catalog registration            PASS
Example MCP smoke               PASS
Real MATLAB pressure test       PASS
```

At the current `plugins` branch state, all of the above are implemented and verified.

## 19. Known deferred work

The following are deliberately deferred and do not block Plugin API v1 completion:

- typed Plugin Config API;
- generic Skill contribution API;
- generic Asset contribution API;
- richer lifecycle context;
- plugin-specific diagnostics / health contributions;
- dynamic package discovery;
- third-party package trust/signature flow;
- out-of-process untrusted plugin host;
- V3 Component/Fiber migration.

They should be introduced only when a real plugin requires them or as part of the V3 architecture.

## 20. Integration contract

When Plugin API v1 is integrated into `develop`:

- plugin framework code may be merged as one feature set;
- deployment success MUST remain independent from plugin health;
- Plugin/Matlab live tests belong to development/integration validation, not one-click deployment gating;
- Core must remain free of MATLAB-specific imports;
- future plugins must enter through `src/plugins/catalog.ts` and the public `src/plugin/api.ts` boundary.

The intended branch flow is:

```text
plugins
  -> develop
  -> integrated validation
  -> main
```

