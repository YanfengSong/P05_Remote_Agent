import type {
  DownstreamDefinition,
  DownstreamWorkspaceBinding
} from "../../downstream/types.js";
import { PLUGIN_API_VERSION, type ApplicationPlugin } from "../../plugin/types.js";

function parseArgs(raw?: string): string[] {
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("MATLAB_MCP_ARGS_JSON must be a JSON array of strings.");
  }
  return value;
}

function parseWorkspaceBinding(): DownstreamWorkspaceBinding {
  const raw = process.env.MATLAB_MCP_WORKSPACE_BINDING?.trim().toLowerCase();
  if (!raw) return process.env.MATLAB_MCP_CWD?.trim() ? "fixed" : "active";
  if (raw === "active" || raw === "platform" || raw === "fixed") return raw;
  throw new Error("MATLAB_MCP_WORKSPACE_BINDING must be active, platform or fixed.");
}

function windowsRootEnv(): Record<string, string> {
  const root = process.env.WINDIR ?? process.env.SystemRoot;
  return root ? { WINDIR: root } : {};
}

export function createMatlabDownstreamDefinition(): DownstreamDefinition {
  const binding = parseWorkspaceBinding();
  const fixedCwd = process.env.MATLAB_MCP_CWD?.trim();

  if (binding === "fixed" && !fixedCwd) {
    throw new Error("MATLAB_MCP_CWD is required when MATLAB_MCP_WORKSPACE_BINDING=fixed.");
  }

  return {
    id: "matlab",
    label: "MathWorks MATLAB MCP Server",
    enabled: (process.env.MATLAB_MCP_ENABLED ?? "false").toLowerCase() === "true",
    command: process.env.MATLAB_MCP_COMMAND?.trim(),
    args: parseArgs(process.env.MATLAB_MCP_ARGS_JSON),
    workspaceBinding: binding,
    ...(binding === "fixed" && fixedCwd ? { cwd: fixedCwd } : {}),
    env: windowsRootEnv()
  };
}

export const matlabPlugin: ApplicationPlugin = {
  manifest: {
    id: "matlab",
    label: "MATLAB / Simulink",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: (process.env.MATLAB_MCP_ENABLED ?? "false").toLowerCase() === "true",
    capabilities: [],
    permissions: {
      workspace: parseWorkspaceBinding(),
      hostEffects: "none"
    }
  },
  downstreamDefinitions: () => [createMatlabDownstreamDefinition()]
};
