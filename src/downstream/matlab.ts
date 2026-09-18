import { config } from "../config.js";
import type { DownstreamDefinition } from "./types.js";

function parseArgs(raw?: string): string[] {
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("MATLAB_MCP_ARGS_JSON must be a JSON array of strings.");
  }
  return value;
}

export const matlabDefinition: DownstreamDefinition = {
  id: "matlab",
  label: "MathWorks MATLAB MCP Server",
  enabled: (process.env.MATLAB_MCP_ENABLED ?? "true").toLowerCase() === "true",
  command: process.env.MATLAB_MCP_COMMAND?.trim(),
  args: parseArgs(process.env.MATLAB_MCP_ARGS_JSON),
  cwd: process.env.MATLAB_MCP_CWD ?? config.defaultCwd,
  env: {
    WINDIR: process.env.WINDIR ?? "C:\\Windows"
  }
};
