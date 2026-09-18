import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { config } from "./config.js";
import { matlabDefinition } from "./downstream/matlab.js";
import { DownstreamRegistry } from "./downstream/registry.js";
import { registerGatewayTools } from "./gateway-tools.js";
import { createExposer, logExposure } from "./policy/expose.js";
import { createToolGate } from "./policy/gate.js";
import { registerDeviceTools } from "./tools/device.js";
import { listDirectory, readTextFile, writeTextFile } from "./tools/files.js";
import { registerPolicyTool } from "./tools/policy.js";
import { runPowerShell } from "./tools/shell.js";

// Fail-closed: an unknown P05_TOOL_PROFILE aborts startup instead of widening the surface.
const gate = createToolGate(process.env);

const registry = new DownstreamRegistry([matlabDefinition]);
process.once("SIGINT", () => void registry.closeAll().finally(() => process.exit(0)));
process.once("SIGTERM", () => void registry.closeAll().finally(() => process.exit(0)));

serveStdio(() => {
  const server = new McpServer({ name: config.name, version: config.version });
  const exposer = createExposer(server, gate);

  registerPolicyTool(exposer, gate);
  registerDeviceTools(exposer);
  registerGatewayTools(exposer, registry);

  exposer.expose("fs_read", {
    description: "Read a UTF-8 text file inside configured allowed roots.",
    inputSchema: z.object({ path: z.string().min(1) })
  }, async ({ path }) => ({ content: [{ type: "text", text: await readTextFile(path) }] }));

  exposer.expose("fs_write", {
    description: "Create or replace a UTF-8 text file inside configured allowed roots.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() })
  }, async ({ path, content }) => ({
    content: [{ type: "text", text: "Wrote " + await writeTextFile(path, content) }]
  }));

  exposer.expose("fs_list", {
    description: "List direct children of a directory inside configured allowed roots.",
    inputSchema: z.object({ path: z.string().min(1) })
  }, async ({ path }) => ({
    content: [{ type: "text", text: (await listDirectory(path)).join("\n") }]
  }));

  exposer.expose("shell_run", {
    description: "Run PowerShell in an allowed working directory; selected destructive commands are blocked.",
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional()
    })
  }, async ({ command, cwd, timeoutMs }) => {
    const result = await runPowerShell(command, cwd, timeoutMs);
    return { content: [{ type: "text", text:
      "cwd: " + result.cwd + "\nSTDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr
    }] };
  });

  logExposure(exposer.report());
  return server;
});
