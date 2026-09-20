/**
 * Tool profile policy — the single source of truth for what a remote client may see.
 *
 * Contract follows TASK-001 of docs/deployment/P05_REMOTE_AGENT_EXECUTION_PLAN.md:
 * a profile decides the visible tool set, tools are registered only when the active
 * profile allows them, an unknown profile fails closed, and `full` is never the default.
 */

import { TEMP_READONLY_ROOT_ENV, readOwnEnv } from "../env.js";

export const TOOL_PROFILE_NAMES = ["discovery", "readonly", "developer", "full"] as const;

export type ToolProfile = (typeof TOOL_PROFILE_NAMES)[number];

export const DEFAULT_TOOL_PROFILE: ToolProfile = "discovery";

/** Cumulative capability ceiling: each profile includes everything below it. */
export const PROFILE_RANK: Record<ToolProfile, number> = {
  discovery: 0,
  readonly: 1,
  developer: 2,
  full: 3
};

export type ToolRisk = "read" | "write" | "execute";

export type ToolSpec = {
  /** MCP tool name as advertised to remote clients. */
  name: string;
  /** Lowest profile whose tool list includes this tool. */
  minProfile: ToolProfile;
  risk: ToolRisk;
  summary: string;
  /**
   * Optional capability gate, evaluated before the profile rank. A gated tool is exposed only
   * when its gate is satisfied on this machine, so declaring it at a profile does not by
   * itself widen the surface. Used by the temporary read-only layer (TMP-R01).
   */
  gate?: "temp-readonly";
};

/**
 * Every exposable tool must be declared here. A tool that is absent cannot be
 * registered: `assertToolDeclared` throws rather than guessing a profile for it.
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "device_info",
    minProfile: "discovery",
    risk: "read",
    summary: "Identity and runtime information for this P05 computer."
  },
  {
    name: "ping",
    minProfile: "discovery",
    risk: "read",
    summary: "Confirm this P05 computer is online and responding."
  },
  {
    name: "fs_read",
    minProfile: "readonly",
    risk: "read",
    summary: "Read a UTF-8 text file inside the configured allowed roots."
  },
  {
    name: "fs_list",
    minProfile: "readonly",
    risk: "read",
    summary: "List the direct children of a directory inside the allowed roots."
  },
  // ---------------------------------------------------------------------------------------
  // TEMPORARY read-only layer (TMP-R01..TMP-R06, docs/adr/ADR-0006).
  //
  // Declared at `discovery` on purpose: the operator enables it per machine with
  // P05_TEMP_READONLY_ROOT, without changing the active tool profile. The gate below keeps
  // the default install unchanged, so `discovery` still exposes exactly device_info + ping
  // unless someone opts in.
  //
  // Deletion path when the Security Broker lands: remove these two specs, the two
  // `exposer.expose` blocks in src/index.ts, src/tools/temp-readonly.ts, its test file, and
  // the P05_TEMP_READONLY_ROOT line from .env. This is NOT the permanent permission model.
  // ---------------------------------------------------------------------------------------
  {
    name: "list_directory",
    minProfile: "discovery",
    risk: "read",
    gate: "temp-readonly",
    summary: "TEMPORARY: list direct children of a directory inside the temporary read-only root."
  },
  {
    name: "read_file",
    minProfile: "discovery",
    risk: "read",
    gate: "temp-readonly",
    summary: "TEMPORARY: read a UTF-8 text file inside the temporary read-only root (1 MB cap)."
  },
  {
    name: "fs_write",
    minProfile: "developer",
    risk: "write",
    summary: "Create or replace a UTF-8 text file inside the allowed roots."
  },
  {
    name: "mcp_status",
    minProfile: "developer",
    risk: "read",
    summary: "Show configured downstream MCP servers and their connection state."
  },
  {
    name: "mcp_list_tools",
    minProfile: "developer",
    risk: "read",
    summary: "Connect to a downstream MCP server and list its tools."
  },
  {
    name: "mcp_call_tool",
    // A generic proxy: whatever the downstream server can do becomes reachable, and for
    // MATLAB that means arbitrary code evaluation. Plan section 3 lists it under "禁止
    // 一开始暴露" (never expose initially) alongside shell_run, so it sits at `full`
    // rather than `developer`. Per-task approved wrappers (TASK-013) are the intended
    // way to give `developer` a narrower downstream surface.
    minProfile: "full",
    risk: "execute",
    summary: "Call an arbitrary tool on a downstream MCP server (generic escape hatch)."
  },
  {
    name: "shell_run",
    minProfile: "full",
    risk: "execute",
    summary: "Run PowerShell. NOT a sandbox: the command itself is not path-confined."
  }
];

/**
 * Tools the plan assigns to a profile but that are not implemented yet, recorded so
 * the profile decision is not re-litigated when they land (TASK-004/005/006/007).
 * Nothing here is exposable today.
 */
export const PLANNED_TOOLS: Record<ToolProfile, readonly string[]> = {
  discovery: [],
  readonly: ["fs_search", "git_status", "git_diff", "git_log"],
  developer: [
    "apply_patch",
    "process_start",
    "process_wait",
    "process_output",
    "process_stop",
    "approved Git mutations",
    "batch_execute"
  ],
  full: []
};

export function specFor(toolName: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === toolName);
}

export function assertToolDeclared(toolName: string): ToolSpec {
  const spec = specFor(toolName);
  if (!spec) {
    throw new Error(
      `Tool "${toolName}" is not declared in src/policy/tool-profile.ts. ` +
        "Every tool must be assigned a profile and a risk before it can be exposed."
    );
  }
  return spec;
}

export type ProfileSource = "env" | "default";

/**
 * Resolve the active profile. Unset means `discovery`; an unrecognised value is a
 * hard error so a typo can never silently widen the surface (plan rule 3.4).
 */
export function resolveToolProfile(raw: string | undefined): { profile: ToolProfile; profileSource: ProfileSource } {
  const trimmed = raw?.trim();
  if (!trimmed) return { profile: DEFAULT_TOOL_PROFILE, profileSource: "default" };

  const lowered = trimmed.toLowerCase();
  if (!(TOOL_PROFILE_NAMES as readonly string[]).includes(lowered)) {
    throw new Error(
      `Unknown P05_TOOL_PROFILE "${raw}". Expected one of: ${TOOL_PROFILE_NAMES.join(", ")}. ` +
        "Refusing to start with an undefined tool policy."
    );
  }
  return { profile: lowered as ToolProfile, profileSource: "env" };
}

/**
 * Gate reasons are evaluated before the profile rank: an unsatisfied capability gate hides the
 * tool whatever the active profile is.
 *
 * The check reads the opt-in variable directly instead of importing `src/config.ts`, because
 * importing that module validates configuration as a side effect - which test files that set the
 * environment after their imports must not trigger. A malformed value is refused at startup by
 * `parseTempReadonlyRoot`, so "blank/absent" is the only state this gate has to recognise.
 */
function gateReason(spec: ToolSpec): string | undefined {
  if (spec.gate === "temp-readonly") {
    const raw = readOwnEnv(TEMP_READONLY_ROOT_ENV)?.trim();
    if (!raw) {
      return `the temporary read-only layer is off (set ${TEMP_READONLY_ROOT_ENV} to enable it)`;
    }
  }
  return undefined;
}

/** The contract named in the execution plan. */
export function isToolAllowed(profile: ToolProfile, toolName: string): boolean {
  return toolDecision(profile, toolName).allowed;
}

export type ToolDecision = {
  tool: string;
  allowed: boolean;
  reason: string;
};

export function toolDecision(profile: ToolProfile, toolName: string): ToolDecision {
  const spec = assertToolDeclared(toolName);
  const gated = gateReason(spec);
  if (gated) {
    return { tool: toolName, allowed: false, reason: gated };
  }
  if (PROFILE_RANK[profile] < PROFILE_RANK[spec.minProfile]) {
    return {
      tool: toolName,
      allowed: false,
      reason: `requires profile "${spec.minProfile}" or higher (active: "${profile}")`
    };
  }
  return {
    tool: toolName,
    allowed: true,
    reason: `included in profile "${profile}"`
  };
}

export type ToolProfileReport = {
  profile: ToolProfile;
  profileSource: ProfileSource;
  exposed: string[];
  suppressed: { tool: string; reason: string }[];
};

export function toolProfileReport(profile: ToolProfile, profileSource: ProfileSource): ToolProfileReport {
  const exposed: string[] = [];
  const suppressed: { tool: string; reason: string }[] = [];

  for (const spec of TOOL_SPECS) {
    const decision = toolDecision(profile, spec.name);
    if (decision.allowed) exposed.push(spec.name);
    else suppressed.push({ tool: spec.name, reason: decision.reason });
  }

  return { profile, profileSource, exposed, suppressed };
}
