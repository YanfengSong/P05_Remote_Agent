export type ToolProfile = "discovery" | "readonly" | "developer" | "full";
export type ToolRisk = "read" | "write" | "execute";

export const CAPABILITY_SCOPES = [
  "platform",
  "workspace",
  "reference",
  "downstream",
  "host",
  "external"
] as const;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];
export type CapabilityDescriptor = {
  name: string;
  minProfile: ToolProfile;
  risk: ToolRisk;
  scope: CapabilityScope;
  summary: string;
};
