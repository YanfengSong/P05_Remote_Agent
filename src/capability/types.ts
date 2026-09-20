export type ToolProfile = "discovery" | "readonly" | "developer" | "full";
export type ToolRisk = "read" | "write" | "execute";

export const CAPABILITY_SCOPES = [
  "platform",
  "workspace",
  "downstream",
  "host",
  "external",
  "temporary"
] as const;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];
export type CapabilityGate = "temp-readonly";

export type CapabilityDescriptor = {
  name: string;
  minProfile: ToolProfile;
  risk: ToolRisk;
  scope: CapabilityScope;
  summary: string;
  gate?: CapabilityGate;
};
