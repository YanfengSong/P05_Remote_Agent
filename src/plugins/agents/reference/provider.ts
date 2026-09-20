import { fileURLToPath } from "node:url";
import type {
  AgentProvider,
  AgentProviderHandle,
  AgentProviderOutput,
  AgentProviderServices,
  AgentProviderStatus
} from "../../../agent/provider.js";
import type { ExecutionContext } from "../../../runtime/context.js";

function psQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function scriptPath(): string {
  return fileURLToPath(new URL("../../../mock/reference-agent.js", import.meta.url));
}

export const referenceStdioProvider: AgentProvider = {
  id: "reference-stdio",
  label: "P05 Reference Stdio Agent",
  writeAccess: false,

  async start(
    context: ExecutionContext,
    services: AgentProviderServices
  ): Promise<AgentProviderHandle> {
    const command = "& " + psQuote(process.execPath) + " " + psQuote(scriptPath());
    const session = await services.processRuntime.startWithContext(context, {
      mode: "command",
      command
    });
    return {
      id: "reference-" + session.id,
      processSessionId: session.id
    };
  },

  async task(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    task: string,
    services: AgentProviderServices
  ): Promise<void> {
    if (!handle.processSessionId) throw new Error("Reference provider has no process session.");
    await services.processRuntime.inputWithContext(
      context,
      handle.processSessionId,
      JSON.stringify({ type: "task", task }),
      true
    );
  },

  async status(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    services: AgentProviderServices
  ): Promise<AgentProviderStatus> {
    if (!handle.processSessionId) return { state: "failed" };
    const view = services.processRuntime.viewWithContext(context, handle.processSessionId);
    if (view.state === "running" || view.state === "starting") return { state: "running" };
    if (view.state === "exited" || view.state === "stopped") {
      return { state: "completed", ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}) };
    }
    return { state: "failed", ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}) };
  },

  async output(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    cursor: number,
    maxChars: number,
    services: AgentProviderServices
  ): Promise<AgentProviderOutput> {
    if (!handle.processSessionId) {
      return { events: [], nextCursor: cursor, truncated: false };
    }
    const output = services.processRuntime.outputWithContext(
      context,
      handle.processSessionId,
      cursor,
      maxChars
    );
    return {
      events: output.events.map((event) => ({
        seq: event.seq,
        channel: event.stream,
        text: event.text,
        timestamp: event.timestamp
      })),
      nextCursor: output.nextCursor,
      truncated: output.truncated
    };
  },

  async stop(
    handle: AgentProviderHandle,
    context: ExecutionContext,
    force: boolean,
    services: AgentProviderServices
  ): Promise<void> {
    if (!handle.processSessionId) return;
    await services.processRuntime.stopWithContext(
      context,
      handle.processSessionId,
      force
    );
  }
};
