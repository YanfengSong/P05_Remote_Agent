import * as z from "zod/v4";
import {
  PLUGIN_API_VERSION,
  definePlugin,
  defineTool,
  pluginResult
} from "../../plugin/api.js";

const enabled =
  (process.env.P05_EXAMPLE_PLUGIN_ENABLED ?? "false").trim().toLowerCase() ===
  "true";

const echoTool = defineTool<{ message?: string }>({
  name: "example.echo",
  description:
    "Reference Plugin API v1 tool. Echo a message and report the active Workspace id.",
  inputSchema: z.object({
    message: z.string().max(500).optional()
  }),
  outputSchema: z.object({
    plugin: z.literal("example"),
    message: z.string(),
    workspaceId: z.string()
  }),
  handler: ({ message }, context) => {
    const workspace = context.workspace.current();
    return pluginResult({
      plugin: "example",
      message: message ?? "example-ok",
      workspaceId: workspace.id
    });
  }
});

export const examplePlugin = definePlugin({
  manifest: {
    id: "example",
    label: "Example Plugin",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled,
    capabilities: [
      {
        name: "example.echo",
        minProfile: "readonly",
        risk: "read",
        scope: "workspace",
        summary:
          "Reference Plugin API v1 echo capability for plugin development validation."
      }
    ],
    permissions: {
      workspace: "active",
      hostEffects: "none"
    }
  },
  tools: [echoTool]
});
