import type { McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import type { PolicyReport, ToolGate } from "./gate.js";

export type ToolConfig<Args> = {
  description?: string;
  inputSchema?: Args;
};

export type Exposer = {
  /**
   * Register a tool only when the active tool profile allows it.
   *
   * Tools are gated at registration time, so a suppressed capability never appears
   * in tools/list and cannot be discovered by a remote client. The handler is
   * additionally re-checked at call time (defence in depth).
   */
  expose<Args extends StandardSchemaWithJSON | undefined>(
    name: string,
    config: ToolConfig<Args>,
    handler: ToolCallback<Args>
  ): void;
  report(): PolicyReport;
};

export function createExposer(server: McpServer, gate: ToolGate): Exposer {
  const exposed: string[] = [];
  const suppressed: { tool: string; reason: string }[] = [];

  const guard = <Args extends StandardSchemaWithJSON | undefined>(
    name: string,
    handler: ToolCallback<Args>
  ): ToolCallback<Args> => {
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      gate.assertExposed(name);
      return (handler as unknown as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
    };
    // Single deliberate erasure boundary: the runtime signature is the SDK's, and
    // assertExposed re-validates before the real handler ever runs.
    return wrapped as unknown as ToolCallback<Args>;
  };

  return {
    expose(name, config, handler) {
      const decision = gate.decision(name); // throws for undeclared tools
      if (!decision.exposed) {
        suppressed.push({ tool: name, reason: decision.reason });
        return;
      }
      server.registerTool(name, config, guard(name, handler));
      exposed.push(name);
    },
    report() {
      return {
        profile: gate.profile,
        profileSource: gate.profileSource,
        exposed,
        suppressed,
        unlockFlags: gate.report().unlockFlags
      };
    }
  };
}

/**
 * Startup exposure report. MUST go to stderr: stdout is the JSON-RPC channel
 * under the stdio transport.
 */
export function logExposure(report: PolicyReport): void {
  process.stderr.write(
    JSON.stringify({
      event: "p05.tool_profile",
      profile: report.profile,
      profileSource: report.profileSource,
      exposed: report.exposed,
      suppressed: report.suppressed,
      unlockFlags: report.unlockFlags.filter((flag) => flag.enabled).map((flag) => flag.flag)
    }) + "\n"
  );
}
