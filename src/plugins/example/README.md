# Example Plugin

This is the runnable reference plugin for P05 Plugin API v1.

It is intentionally small. Its job is to show the minimum shape of a plugin.

## Enable

Set in machine-local `.env`:

```text
P05_EXAMPLE_PLUGIN_ENABLED=true
```

Restart the selected P05 Runtime.

## Capability

```text
example.echo
```

Profile: `readonly+`  
Scope: `workspace`

## Call

Input:

```json
{
  "message": "hello"
}
```

Output:

```json
{
  "plugin": "example",
  "message": "hello",
  "workspaceId": "<active workspace id>"
}
```

The plugin reads the active Workspace through `PluginContext`; it does not import `WorkspaceManager`.

## Starting a new simple plugin

1. Copy this directory.
2. Change plugin id / label / version.
3. Declare capabilities.
4. Define tools with `defineTool()`.
5. Add the plugin export to `src/plugins/catalog.ts`.
6. Add tests.

See `docs/architecture/PLUGIN_DEVELOPMENT_STANDARD.md`.
