import {
  PROFILE_NAMES,
  PROFILE_RANK,
  TOOL_SPECS,
  declaredUnlockFlags,
  specFor,
  type ToolProfile
} from "./spec.js";

export type ProfileSource = "env" | "default";

export type ToolDecision = {
  tool: string;
  exposed: boolean;
  reason: string;
};

export type PolicyReport = {
  profile: ToolProfile;
  profileSource: ProfileSource;
  exposed: string[];
  suppressed: { tool: string; reason: string }[];
  unlockFlags: { flag: string; enabled: boolean; appliesTo: string[] }[];
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Local unlock flags accept 1/true/yes/on (case-insensitive); anything else is off. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Resolve the active profile. An unset value falls back to "safe"; an unknown
 * value is a hard error so a typo can never silently widen the surface.
 */
export function normalizeProfile(raw: string | undefined): { profile: ToolProfile; source: ProfileSource } {
  const trimmed = raw?.trim();
  if (!trimmed) return { profile: "safe", source: "default" };

  const lowered = trimmed.toLowerCase();
  if (!(PROFILE_NAMES as readonly string[]).includes(lowered)) {
    throw new Error(
      `Unknown P05_TOOL_PROFILE "${raw}". Expected one of: ${PROFILE_NAMES.join(", ")}. ` +
        "Refusing to start with an undefined tool policy."
    );
  }
  return { profile: lowered as ToolProfile, source: "env" };
}

export class ToolGate {
  readonly profile: ToolProfile;
  readonly profileSource: ProfileSource;
  private readonly env: Record<string, string | undefined>;

  constructor(profile: ToolProfile, profileSource: ProfileSource, env: Record<string, string | undefined>) {
    this.profile = profile;
    this.profileSource = profileSource;
    this.env = env;
  }

  /**
   * Decide whether a tool may be exposed.
   * Throws for a name that is not declared in the catalog: an undeclared tool is a
   * programming error, not something to silently allow or silently drop.
   */
  decision(toolName: string): ToolDecision {
    const spec = specFor(toolName);
    if (!spec) {
      throw new Error(
        `Tool "${toolName}" is not declared in src/policy/spec.ts. ` +
          "Every tool must be declared with an explicit profile and risk before it can be exposed."
      );
    }

    if (PROFILE_RANK[this.profile] < PROFILE_RANK[spec.minProfile]) {
      return {
        tool: toolName,
        exposed: false,
        reason: `requires profile "${spec.minProfile}" or higher (active: "${this.profile}")`
      };
    }

    if (spec.unlockFlag && !isTruthyFlag(this.env[spec.unlockFlag])) {
      return {
        tool: toolName,
        exposed: false,
        reason: `risk "${spec.risk}" requires local unlock: set ${spec.unlockFlag}=1 (not set)`
      };
    }

    return { tool: toolName, exposed: true, reason: "allowed by profile and local unlock state" };
  }

  isExposed(toolName: string): boolean {
    return this.decision(toolName).exposed;
  }

  /** Runtime re-check used inside tool handlers (defence in depth). */
  assertExposed(toolName: string): void {
    const decision = this.decision(toolName);
    if (!decision.exposed) {
      throw new Error(`Tool "${toolName}" is not exposed by the active tool profile: ${decision.reason}.`);
    }
  }

  report(): PolicyReport {
    const exposed: string[] = [];
    const suppressed: { tool: string; reason: string }[] = [];

    for (const spec of TOOL_SPECS) {
      const decision = this.decision(spec.name);
      if (decision.exposed) exposed.push(spec.name);
      else suppressed.push({ tool: spec.name, reason: decision.reason });
    }

    return {
      profile: this.profile,
      profileSource: this.profileSource,
      exposed,
      suppressed,
      unlockFlags: declaredUnlockFlags().map((flag) => ({
        flag,
        enabled: isTruthyFlag(this.env[flag]),
        appliesTo: TOOL_SPECS.filter((spec) => spec.unlockFlag === flag).map((spec) => spec.name)
      }))
    };
  }
}

export function createToolGate(env: Record<string, string | undefined>): ToolGate {
  const { profile, source } = normalizeProfile(env.P05_TOOL_PROFILE);
  return new ToolGate(profile, source, env);
}
