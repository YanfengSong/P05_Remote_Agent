# P05 Plugin Framework

Status: Foundation V2 implemented
Date: 2026-09-20

## Purpose

Application-specific automation is isolated from P05 Core.

Framework:
- `src/plugin/types.ts`
- `src/plugin/registry.ts`
- `src/plugin/runtime.ts`

Built-in application plugins:
- `src/plugins/*`

## Security model

Plugins are trusted reviewed code that ships with the P05 build.

There is intentionally no arbitrary path loader.

A plugin can extend remote capability only through its Manifest and the Core Exposer. Remote plugin tool calls are
wrapped with active-workspace plugin authorization before entering the plugin handler, and then continue through the
normal P05 Policy / Runtime / Audit chain.

This is not OS sandboxing of in-process trusted plugin source. If third-party plugins are distributed independently,
they must use signed/reviewed packages or an out-of-process isolated plugin host.

## Manifest requirements

- stable id;
- semantic plugin version;
- supported plugin API version;
- enabled flag;
- prefixed capability names;
- declared permissions;
- dependencies.

A plugin with `hostEffects=none` cannot declare host/external capabilities.

A downstream contribution must use the same workspace binding declared by the manifest.

## Workspace activation

Workspace JSON may optionally contain:

```json
{
  "id": "vehicle",
  "root": "D:\\Project_Git\\P02_Vmodel",
  "kind": "git-project",
  "plugins": ["matlab", "stm32"]
}
```

If `plugins` is omitted, installed/enabled plugins are permitted by default.
An empty list disables all application plugins for that workspace.

## Lifecycle

Plugin states:
- disabled
- ready
- running
- failed
- stopped

A plugin start failure remains local to the plugin.

## MATLAB reference plugin

Location:
- `src/plugins/matlab/plugin.ts`

The Core entrypoint has no MATLAB-specific import or configuration.

MATLAB contributes a downstream MCP adapter and declares its workspace-binding requirement through the common
plugin contract.
