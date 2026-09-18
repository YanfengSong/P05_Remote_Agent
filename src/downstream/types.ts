export type DownstreamDefinition = {
  id: string;
  label: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type DownstreamStatus = {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  lastError?: string;
};

export type DownstreamTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};
