import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback
} from "@modelcontextprotocol/server";
import {
  DEFAULT_CAPABILITY_CATALOG,
  type CapabilityCatalog
} from "../capability/registry.js";
import { summarizeToolInput } from "../monitor/live-activity.js";
import type { ExecutionRuntime } from "../runtime/execution.js";
import {
  assertToolDeclared,
  toolDecision,
  toolProfileReport,
  type ProfileSource,
  type ToolProfile,
  type ToolProfileReport
} from "./tool-profile.js";

export type ToolConfig<
  Args extends StandardSchemaWithJSON | undefined,
  Output extends StandardSchemaWithJSON | undefined = undefined
> = {
  description?: string;
  inputSchema?: Args;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
};

export type Exposer = {
  /**
   * Register a tool only when the active profile allows it.
   *
   * Suppressed tools are not advertised in tools/list. The handler is additionally
   * re-checked at call time as defence in depth.
   *
   * outputSchema is part of the public MCP contract. Handlers that declare one must
   * also return matching structuredContent; the SDK validates that result.
   */
  expose<
    Args extends StandardSchemaWithJSON | undefined,
    Output extends StandardSchemaWithJSON | undefined = undefined
  >(
    name: string,
    config: ToolConfig<Args, Output>,
    handler: ToolCallback<Args>
  ): void;
  report(): ToolProfileReport;
};


function capabilityAnnotations(
  name: string,
  catalog: CapabilityCatalog
): ToolAnnotations {
  const descriptor = catalog.descriptor(name);
  const readOnly = descriptor.risk === "read";
  const openWorld =
    descriptor.scope === "downstream" || descriptor.scope === "external";

  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: readOnly,
    openWorldHint: openWorld
  };
}

export function createExposer(
  server: McpServer,
  profile: ToolProfile,
  profileSource: ProfileSource,
  runtime?: ExecutionRuntime,
  catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
): Exposer {
  const exposed: string[] = [];
  const suppressed: { tool: string; reason: string }[] = [];

  const guard = <Args extends StandardSchemaWithJSON | undefined>(
    name: string,
    handler: ToolCallback<Args>
  ): ToolCallback<Args> => {
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const decision = toolDecision(profile, name, catalog);
      if (!decision.allowed) {
        throw new Error(
          `Tool "${name}" is not exposed by profile "${profile}": ${decision.reason}.`
        );
      }

      const operation = () =>
        Promise.resolve(
          (handler as unknown as (...innerArgs: unknown[]) => unknown)(...args)
        );

      const liveDetail = summarizeToolInput(name, args[0]);
      if (!runtime) return operation();

      // MCP client identity is negotiated at initialize-time by the SDK. It is
      // audit metadata only; authorization never depends on the client-reported
      // name/version because those values are descriptive, not trusted identity.
      const client = server.server.getClientVersion();
      return runtime.run(
        name,
        operation,
        liveDetail,
        client
          ? {
              clientName: client.name,
              clientVersion: client.version
            }
          : undefined
      );
    };

    // Single deliberate erasure boundary: the runtime signature is the SDK's.
    return wrapped as unknown as ToolCallback<Args>;
  };

  return {
    expose(name, config, handler) {
      assertToolDeclared(name, catalog);
      const decision = toolDecision(profile, name, catalog);
      if (!decision.allowed) {
        suppressed.push({ tool: name, reason: decision.reason });
        return;
      }

      // The SDK overload couples input/output schema generics more tightly than this
      // policy wrapper can preserve. Keep the erasure at this single registration
      // boundary; every caller still passes typed StandardSchema objects.
      const registrationConfig = {
        ...config,
        annotations:
          config.annotations ?? capabilityAnnotations(name, catalog)
      };

      (
        server.registerTool as unknown as (
          toolName: string,
          toolConfig: unknown,
          toolHandler: unknown
        ) => unknown
      )(name, registrationConfig, guard(name, handler));
      exposed.push(name);
    },

    report() {
      const base = toolProfileReport(profile, profileSource, catalog);
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