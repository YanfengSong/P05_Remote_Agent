/**
 * Tool profile spec — the single source of truth for what a remote client may see.
 *
 * Exposure rule (fail-closed, two keys):
 *   1. profile ceiling: the active P05_TOOL_PROFILE must be at or above `minProfile`;
 *   2. local unlock: a tool that writes or executes is exposed only when its
 *      `unlockFlag` environment variable is truthy.
 *
 * A tool that is not exposed here is NEVER registered on the MCP server, so a
 * remote client cannot discover it via tools/list.
 */

export const PROFILE_NAMES = ["safe", "dev", "full"] as const;

export type ToolProfile = (typeof PROFILE_NAMES)[number];

/** Capability ceiling ranking. Higher profile includes everything below it. */
export const PROFILE_RANK: Record<ToolProfile, number> = {
  safe: 0,
  dev: 1,
  full: 2
};

export type ToolRisk = "read" | "write" | "execute";

export type ToolSpec = {
  /** MCP tool name as advertised to remote clients. */
  name: string;
  /** Lowest profile that may expose this tool. */
  minProfile: ToolProfile;
  risk: ToolRisk;
  /**
   * Local-only unlock flag. Required in addition to the profile check for every
   * tool whose risk is "write" or "execute".
   */
  unlockFlag?: string;
  summary: string;
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "device_info",
    minProfile: "safe",
    risk: "read",
    summary: "Identity and runtime information for this P05 computer."
  },
  {
    name: "ping",
    minProfile: "safe",
    risk: "read",
    summary: "Confirm this P05 computer is online and responding."
  },
  {
    name: "policy_info",
    minProfile: "safe",
    risk: "read",
    summary: "Report the active tool profile, exposed tools, suppressed tools and local unlock flags."
  },
  {
    name: "fs_read",
    minProfile: "safe",
    risk: "read",
    summary: "Read a UTF-8 text file inside configured allowed roots."
  },
  {
    name: "fs_list",
    minProfile: "safe",
    risk: "read",
    summary: "List direct children of a directory inside configured allowed roots."
  },
  {
    name: "fs_write",
    minProfile: "dev",
    risk: "write",
    unlockFlag: "P05_ENABLE_FS_WRITE",
    summary: "Create or replace a UTF-8 text file inside allowed roots. Requires local unlock."
  },
  {
    name: "mcp_status",
    minProfile: "dev",
    risk: "read",
    summary: "Show configured downstream MCP servers and their connection state."
  },
  {
    name: "mcp_list_tools",
    minProfile: "dev",
    risk: "read",
    summary: "Connect to a downstream MCP server and list its tools."
  },
  {
    name: "shell_run",
    minProfile: "full",
    risk: "execute",
    unlockFlag: "P05_ENABLE_SHELL",
    summary: "Run PowerShell. NOT a sandbox: the command string itself is not path-confined. Requires local unlock."
  },
  {
    name: "mcp_call_tool",
    minProfile: "full",
    risk: "execute",
    unlockFlag: "P05_ENABLE_DOWNSTREAM_EXEC",
    summary: "Call one tool on a downstream MCP server (e.g. MATLAB evaluate). Second execution surface. Requires local unlock."
  }
];

export function specFor(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === name);
}

/** All unlock flags declared anywhere in the catalog, deduplicated. */
export function declaredUnlockFlags(): string[] {
  return [...new Set(TOOL_SPECS.map((spec) => spec.unlockFlag).filter((flag): flag is string => Boolean(flag)))];
}
