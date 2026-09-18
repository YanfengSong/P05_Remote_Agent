import type { McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import {
  assertToolDeclared,
  toolDecision,
  toolProfileReport,
  type ProfileSource,
  type ToolProfile,
  type ToolProfileReport
} from "./tool-profile.js";

export type ToolConfig<Args> = {
  description?: string;
  inputSchema?: Args;
};

export type Exposer = {
  /**
   * Register a tool only when the active profile allows it.
   *
   * The plan requires registering conditionally, not registering everything and
   * checking at execution time: a suppressed tool is never advertised, so a remote
   * client cannot discover it through tools/list. The handler is additionally
   * re-checked at call time (defence in depth).
   */
  expose<Args extends StandardSchemaWithJSON | undefined>(
    name: string,
    config: ToolConfig<Args>,
    handler: ToolCallback<Args>
  ): void;
  report(): ToolProfileReport;
};

export function createExposer(server: McpServer, profile: ToolProfile, profileSource: ProfileSource): Exposer {
  const exposed: string[] = [];
  const suppressed: { tool: string; reason: string }[] = [];

  const guard = <Args extends StandardSchemaWithJSON | undefined>(
    name: string,
    handler: ToolCallback<Args>
  ): ToolCallback<Args> => {
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const decision = toolDecision(profile, name);
      if (!decision.allowed) {
        throw new Error(`Tool "${name}" is not exposed by profile "${profile}": ${decision.reason}.`);
      }
      return (handler as unknown as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
    };
    // Single deliberate erasure boundary: the runtime signature is the SDK's, and the
    // profile is re-checked before the real handler ever runs.
    return wrapped as unknown as ToolCallback<Args>;
  };

  return {
    expose(name, config, handler) {
      assertToolDeclared(name); // throws for an undeclared tool
      const decision = toolDecision(profile, name);
      if (!decision.allowed) {
        suppressed.push({ tool: name, reason: decision.reason });
        return;
      }
      server.registerTool(name, config, guard(name, handler));
      exposed.push(name);
    },
    report() {
      const base = toolProfileReport(profile, profileSource);
      return { ...base, exposed, suppressed };
    }
  };
}

/**
 * Startup exposure report. MUST go to stderr: stdout is the JSON-RPC channel
 * under the stdio transport.
 */
export function logExposure(report: ToolProfileReport): void {
  process.stderr.write(
    JSON.stringify({
      event: "p05.tool_profile",
      profile: report.profile,
      profileSource: report.profileSource,
      exposed: report.exposed,
      suppressed: report.suppressed
    }) + "\n"
  );
}
