import { PLUGIN_API_VERSION, type ApplicationPlugin } from "../../../plugin/types.js";
import { referenceStdioProvider } from "./provider.js";

export const referenceAgentPlugin: ApplicationPlugin = {
  manifest: {
    id: "agent-reference",
    label: "P05 Reference Agent Provider",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: (process.env.P05_REFERENCE_AGENT_ENABLED ?? "false").toLowerCase() === "true",
    capabilities: [],
    permissions: {
      workspace: "active",
      hostEffects: "none"
    }
  },
  agentProviders: () => [referenceStdioProvider]
};
