import type { ProcessRuntime } from "../process/runtime.js";
import type { ExecutionContext } from "../runtime/context.js";

export type AgentProviderServices = {
  processRuntime: ProcessRuntime;
};

export type AgentProviderHandle = {
  id: string;
  processSessionId?: string;
};

export type AgentProviderStatus = {
  state: "running" | "completed" | "failed";
  exitCode?: number | null;
};

export type AgentProviderOutputEvent = {
  seq: number;
  channel: string;
  text: string;
  timestamp: string;
};

export type AgentProviderOutput = {
  events: AgentProviderOutputEvent[];
  nextCursor: number;
  truncated: boolean;
};

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly writeAccess: boolean;

  start(
    context: ExecutionContext,
    services: AgentProviderServices
  ): Promise<AgentProviderHandle>;

  task(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    task: string,
    services: AgentProviderServices
  ): Promise<void>;

  status(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    services: AgentProviderServices
  ): Promise<AgentProviderStatus>;

  output(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    cursor: number,
    maxChars: number,
    services: AgentProviderServices
  ): Promise<AgentProviderOutput>;

  stop(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    force: boolean,
    services: AgentProviderServices
  ): Promise<void>;
}
