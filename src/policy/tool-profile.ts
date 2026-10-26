import {
  CAPABILITIES,
  DEFAULT_CAPABILITY_CATALOG,
  type CapabilityCatalog
} from "../capability/registry.js";
import type {
  CapabilityDescriptor,
  ToolProfile,
  ToolRisk
} from "../capability/types.js";

export const TOOL_PROFILE_NAMES = ["discovery", "readonly", "developer", "full"] as const;
export type { ToolProfile, ToolRisk, CapabilityDescriptor as ToolSpec };

export const DEFAULT_TOOL_PROFILE: ToolProfile = "discovery";

export const PROFILE_RANK: Record<ToolProfile, number> = {
  discovery: 0,
  readonly: 1,
  developer: 2,
  full: 3
};

/** Compatibility alias. Canonical metadata lives in CapabilityCatalog. */
export const TOOL_SPECS: readonly CapabilityDescriptor[] = CAPABILITIES;

export const PLANNED_TOOLS: Record<ToolProfile, readonly string[]> = {
  discovery: [],
  readonly: ["git_log"],
  developer: ["process_start", "process_wait", "process_output", "process_stop", "batch_execute"],
  full: []
};

export function specFor(
  toolName: string,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): CapabilityDescriptor | undefined {
  return catalog.maybe(toolName);
}

export function assertToolDeclared(
  toolName: string,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): CapabilityDescriptor {
  return catalog.descriptor(toolName);
}

export type ProfileSource = "env" | "default" | "runtime-state";

export function resolveToolProfile(
  raw: string | undefined,
  sourceOverride?: ProfileSource
): { profile: ToolProfile; profileSource: ProfileSource } {
  const trimmed = raw?.trim();
  if (!trimmed) return { profile: DEFAULT_TOOL_PROFILE, profileSource: "default" };

  const lowered = trimmed.toLowerCase();
  if (!(TOOL_PROFILE_NAMES as readonly string[]).includes(lowered)) {
    throw new Error(
      `Unknown P05_TOOL_PROFILE "${raw}". Expected one of: ${TOOL_PROFILE_NAMES.join(", ")}. ` +
        "Refusing to start with an undefined tool policy."
    );
  }
  return { profile: lowered as ToolProfile, profileSource: sourceOverride ?? "env" };
}

export function isToolAllowed(
  profile: ToolProfile,
  toolName: string,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): boolean {
  return toolDecision(profile, toolName, catalog).allowed;
}

export type ToolDecision = {
  tool: string;
  allowed: boolean;
  reason: string;
};

export function toolDecision(
  profile: ToolProfile,
  toolName: string,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): ToolDecision {
  const spec = assertToolDeclared(toolName, catalog);
  // The batch reader also handles a single path, so avoid exposing two
  // competing read tools to agents. Keep the legacy endpoint opt-in for
  // existing clients that depend on fs_read's original response schema.
  if (toolName === "fs_read" && process.env.P05_EXPOSE_LEGACY_FS_READ !== "1") {
    return {
      tool: toolName,
      allowed: false,
      reason: 'legacy fs_read is hidden by default; set P05_EXPOSE_LEGACY_FS_READ=1 to enable compatibility'
    };
  }
  if (PROFILE_RANK[profile] < PROFILE_RANK[spec.minProfile]) {
    return {
      tool: toolName,
      allowed: false,
      reason: `requires profile "${spec.minProfile}" or higher (active: "${profile}")`
    };
  }
  return { tool: toolName, allowed: true, reason: `included in profile "${profile}"` };
}

export type ToolProfileReport = {
  profile: ToolProfile;
  profileSource: ProfileSource;
  exposed: string[];
  suppressed: { tool: string; reason: string }[];
};

export function toolProfileReport(
  profile: ToolProfile,
  profileSource: ProfileSource,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): ToolProfileReport {
  const exposed: string[] = [];
  const suppressed: { tool: string; reason: string }[] = [];

  for (const spec of catalog.list()) {
    const decision = toolDecision(profile, spec.name, catalog);
    if (decision.allowed) exposed.push(spec.name);
    else suppressed.push({ tool: spec.name, reason: decision.reason });
  }
  return { profile, profileSource, exposed, suppressed };
}
