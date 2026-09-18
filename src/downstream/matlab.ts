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

/**
 * MATLAB is an opt-in per machine: the executable path and the MATLAB root differ
 * everywhere, so there is no default of either. Enabling it requires an explicit
 * MATLAB_MCP_ENABLED=true plus a command, and a machine without MATLAB simply shows
 * `enabled: false` in `mcp_status` instead of failing to start.
 */
export const matlabDefinition: DownstreamDefinition = {
  id: "matlab",
  label: "MathWorks MATLAB MCP Server",
  enabled: (process.env.MATLAB_MCP_ENABLED ?? "false").toLowerCase() === "true",
  command: process.env.MATLAB_MCP_COMMAND?.trim(),
  args: parseArgs(process.env.MATLAB_MCP_ARGS_JSON),
  cwd: process.env.MATLAB_MCP_CWD ?? config.defaultCwd,
  // Taken from the environment rather than assumed: an inherited WINDIR is what a spawned
  // helper actually needs, and a hardcoded C:\Windows would be wrong on a non-system drive.
  env: windowsRootEnv()
};

function windowsRootEnv(): Record<string, string> {
  const root = process.env.WINDIR ?? process.env.SystemRoot;
  return root ? { WINDIR: root } : {};
}
