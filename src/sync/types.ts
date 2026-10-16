export const GOLDEN_STATE_SCHEMA_VERSION = 1 as const;

export type GoldenWorkspace = {
  id: string;
  kind: string;
  label?: string;
  plugins?: string[];
  rootBinding: "local";
};

export type GoldenReference = {
  id: string;
  label: string;
  rootBinding: "local";
};

export type GoldenPlugin = {
  id: string;
  label: string;
  version: string;
  apiVersion: string;
  enabled: boolean;
  permissions: {
    workspace: string;
    hostEffects: string;
  };
  dependencies: Array<{ id: string; optional: boolean }>;
};

export type GoldenDownstream = {
  id: string;
  label: string;
  enabled: boolean;
  workspaceBinding: string;
  requestTimeoutMs?: number;
};

export type GoldenRuntimeSlot = {
  id: "A" | "B";
  profileName: string;
};

export type GoldenState = {
  kind: "p05-golden-state";
  schemaVersion: typeof GOLDEN_STATE_SCHEMA_VERSION;
  generatedAt: string;
  revision: string;
  source: {
    agentVersion: string;
    gitCommit: string;
  };
  policy: {
    toolProfile: string;
    approvalMode: string;
  };
  runtime: {
    slots: GoldenRuntimeSlot[];
  };
  workspace: {
    activeId: string;
    entries: GoldenWorkspace[];
  };
  references: GoldenReference[];
  plugins: GoldenPlugin[];
  downstream: GoldenDownstream[];
  capabilities: {
    names: string[];
    catalogSha256: string;
  };
};

export type GoldenStateDrift = {
  status: "in_sync" | "drift";
  desiredRevision: string;
  localRevision: string;
  changes: Array<{
    path: string;
    desired?: unknown;
    local?: unknown;
  }>;
};

