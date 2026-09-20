export const WORKSPACE_KINDS = ["platform-source", "git-project", "generic"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export type WorkspaceAuthorization = {
  structuredCrossWorkspace: "deny";
  externalPersistentWrite: "approval-required";
  shellBoundary: "trusted-user";
};

export const DEFAULT_WORKSPACE_AUTHORIZATION: WorkspaceAuthorization = {
  structuredCrossWorkspace: "deny",
  externalPersistentWrite: "approval-required",
  shellBoundary: "trusted-user"
};

export type WorkspaceDescriptor = {
  id: string;
  root: string;
  kind: WorkspaceKind;
  label?: string;
  /** Undefined means all installed/enabled application plugins are permitted. */
  plugins?: readonly string[];
  authorization: WorkspaceAuthorization;
};

export type WorkspaceView = {
  id: string;
  kind: WorkspaceKind;
  label?: string;
  current: boolean;
  platform: boolean;
  plugins?: readonly string[];
  authorization: WorkspaceAuthorization;
};