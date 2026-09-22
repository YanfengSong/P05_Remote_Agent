# P05 Plugin Development Standard

Status: **v0.1 runnable draft**  
Branch: `plugins`

Implementation reference: `PLUGIN_API_V1_TECHNICAL_DESIGN.md`

This standard defines how P05 private/first-party plugins should be written. The goal is repeatable plugin development for a small trusted group, not a public plugin marketplace.

## 1. Goal

The intended workflow is:

```text
copy example
→ choose plugin id
→ declare manifest/capabilities
→ define tools
→ add optional downstream/skills/assets
→ add plugin to local catalog
→ run contract tests
→ done
```

Adding a plugin should not require plugin-specific changes in P05 Core.

## 2. Current v0.1 architecture

```text
P05 Core
   │
   ├─ PluginRegistry
   ├─ PluginRuntime
   └─ Public Plugin API v1
          │
          ├─ definePlugin()
          ├─ defineTool()
          ├─ PluginContext
          └─ pluginResult()
                 │
                 └─ Local Plugin Catalog
                        ├─ MATLAB
                        └─ Example
```

The source-controlled local catalog is `src/plugins/catalog.ts`. Core imports only the catalog surface.

## 3. Plugin layout

```text
src/plugins/<plugin-id>/
├─ plugin.ts
├─ README.md
├─ tools/          # optional when plugin grows
├─ downstream/     # optional
├─ skills/         # optional
├─ assets/         # optional
└─ test/           # optional plugin-local tests
```

Small plugins may stay in one `plugin.ts`.

## 4. Public API boundary

New Plugin API v1 plugins MUST import P05 plugin contracts through `src/plugin/api.ts`.

Example:

```ts
import {
  PLUGIN_API_VERSION,
  definePlugin,
  defineTool,
  pluginResult
} from "../../plugin/api.js";
```

New plugins SHOULD NOT import Core implementation modules such as `src/index.ts`, `src/security.ts`, `src/workspace/manager.ts`, `src/operator/*`, or `src/runtime/*`.

MATLAB/Simulink is now the first real complex plugin migrated to Plugin API v1. It uses declarative `tools[]`, `defineTool()`, `defineDownstream()`, `PluginContext`, and no longer uses the legacy `registerTools()` hook.

## 5. Minimum manifest

```ts
export const myPlugin = definePlugin({
  manifest: {
    id: "myplugin",
    label: "My Plugin",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: true,
    capabilities: [],
    permissions: {
      workspace: "active",
      hostEffects: "none"
    }
  }
});
```

Plugin ids MUST match `[a-z0-9][a-z0-9._-]{0,63}` and remain stable.

## 6. Capability and tool rules

Every callable declarative tool MUST have a matching manifest capability.

```ts
capabilities: [{
  name: "myplugin.echo",
  minProfile: "readonly",
  risk: "read",
  scope: "workspace",
  summary: "Echo one message."
}]
```

Rules:

- capability and tool names MUST use the `<plugin-id>.` prefix;
- declarative tools MUST have a capability with the same name;
- duplicates fail closed;
- `hostEffects=none` cannot declare host/external capabilities;
- P05 Core remains responsible for Profile and Workspace authorization.

## 7. Declarative tools

New tools SHOULD use `defineTool()`:

```ts
const echoTool = defineTool<{ message?: string }>({
  name: "myplugin.echo",
  description: "Echo a message.",
  inputSchema: z.object({
    message: z.string().optional()
  }),
  outputSchema: z.object({
    message: z.string()
  }),
  handler: ({ message }, context) => {
    return pluginResult({
      message: message ?? "ok"
    });
  }
});
```

Attach tools declaratively with `tools: [echoTool]`.

The legacy imperative `registerTools()` hook remains supported temporarily for existing plugins. New plugins SHOULD NOT use it.

## 8. PluginContext v0.1

Tool handlers currently receive:

```text
context.workspace.current()
context.workspace.root()

context.downstream.listTools(...)
context.downstream.callTool(...)
```

The Workspace view is read-only.

Downstream access is ownership-scoped. A plugin can call only downstream MCP servers contributed by that same plugin.

## 9. Workspace policy

Plugins remain subject to the active Workspace allowlist.

A plugin can be installed/enabled globally while unavailable in the current Workspace. Tool calls are re-checked at invocation time.

## 10. Lifecycle

Current lifecycle states remain:

```text
disabled
ready
running
failed
stopped
```

Start failure remains isolated.

The public lifecycle context is intentionally NOT frozen in v0.1. MATLAB migration did not require a custom lifecycle context because its downstream connection remains lazy and owned by the shared Downstream runtime. A future plugin with explicit long-running host resources should drive this contract.

## 11. Configuration

Configuration is also intentionally NOT frozen in v0.1.

Current plugins may still use machine-local environment variables. The target is a typed Plugin Config API so plugin code receives validated configuration instead of reading arbitrary environment variables throughout the module.

## 12. Local catalog

Private/first-party plugins are explicitly registered in `src/plugins/catalog.ts`.

This is deliberate:

- no directory scanning;
- no execution of arbitrary downloaded JavaScript;
- no marketplace;
- no public registry.

For the current trusted/private use case, explicit source-controlled registration is sufficient and auditable.

## 13. Minimum tests

A plugin is not complete until it verifies at least:

```text
manifest accepted
API version accepted
capability/tool names valid
matching capability exists
profile gate works
Workspace gate works
tool schema works
tool result works
README exists
```

Add lifecycle/downstream tests when those features are used.

The Example Plugin has a real MCP smoke test:

```text
P05 Runtime
→ MCP tools/list
→ example.echo
→ structuredContent
```

Source: `src/test/plugin-api-v1.ts`.

## 14. Definition of Done

For v0.1:

```text
Manifest        ✓
Capabilities    ✓
Tools           ✓
Workspace gate  ✓
Tests           ✓
README          ✓
Catalog entry   ✓
```

Add Config, Downstream MCP, Skills, Assets, and Lifecycle only when the plugin needs them.

## 15. Pressure-test result

MATLAB/Simulink has now been migrated to Plugin API v1 without losing the existing behavior.

Validated on the real local MathWorks Agentic Toolkit / MATLAB MCP stack:

```text
declarative MATLAB tools exposed      ✓
real MathWorks skill list             ✓
real MathWorks skill read             ✓
real downstream MCP tool discovery    ✓
Workspace escape rejected             ✓
real evaluate_matlab_code             ✓
MATLAB plugin remains running         ✓
downstream ownership preserved        ✓
```

The live pressure test is:

```text
src/test/matlab-plugin-v1-live.ts
```

Current live result:

```text
MATLAB_PLUGIN_V1_LIVE_OK (8 checks)
```

The migration confirms that the v0.1 Tool / Workspace / Downstream shape is usable.

The next API pressure points are now:

- typed plugin configuration;
- first-class Skill / Asset contribution APIs;
- lifecycle context only when a plugin with explicit long-running host resources requires it;
- diagnostics / health contribution.

Do not add those abstractions until a real plugin needs them.
