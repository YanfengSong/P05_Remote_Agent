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
import { TEMP_READONLY_ROOT_ENV, readOwnEnv } from "../env.js";

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
  developer: ["batch_execute"],
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

export type ProfileSource = "env" | "default";

export function resolveToolProfile(
  raw: string | undefined
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
  return { profile: lowered as ToolProfile, profileSource: "env" };
}

function gateReason(spec: CapabilityDescriptor): string | undefined {
  if (spec.gate === "temp-readonly") {
    const raw = readOwnEnv(TEMP_READONLY_ROOT_ENV)?.trim();
    if (!raw) {
      return `the temporary read-only layer is off (set ${TEMP_READONLY_ROOT_ENV} to enable it)`;
    }
  }
  return undefined;
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
  const gated = gateReason(spec);
  if (gated) return { tool: toolName, allowed: false, reason: gated };

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
