import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createRpcClient, RpcError } from "./v3/transport/rpc.js";

function readClientToken(): string {
  const file = process.env.P05_V3_CLIENT_TOKEN_FILE;
  if (file) {
    if (fs.statSync(file).size > 1024) throw new Error("Invalid client credential file.");
    return fs.readFileSync(file, "utf8").trim();
  }
  return process.env.P05_V3_CLIENT_TOKEN ?? "";
}

try {
  const rpc = createRpcClient({
    url: process.env.P05_V3_ENDPOINT ?? "",
    token: readClientToken()
  });
  const call = async (method: string, input: unknown) => {
    try {
      const result = await rpc.call(method, input);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new RpcError("INVALID_RESPONSE");
      return {
        ...("error" in result ? { isError: true } : {}),
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof RpcError ? error.message : "V3 transport: REQUEST_FAILED" }]
      };
    }
  };
  serveStdio(() => {
    const server = new McpServer({ name: "p05-v3-edge", version: "0.1.0" });
    server.registerTool("execution_submit", {
      description: "Submit a durable capability execution. Query its identity after a transport timeout; do not assume cancellation.",
      inputSchema: z.object({ capability: z.string().min(1).max(160), input: z.json(), idempotencyKey: z.string().min(1).max(256) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, (input) => call("execution_submit", input));
    server.registerTool("execution_status", {
      description: "Read the durable state of an execution.",
      inputSchema: z.object({ id: z.string().min(1).max(160) }),
      annotations: { readOnlyHint: true }
    }, (input) => call("execution_status", input));
    server.registerTool("execution_wait", {
      description: "Wait briefly for a state change. Reaching the wait deadline does not cancel execution.",
      inputSchema: z.object({ id: z.string().min(1).max(160), afterVersion: z.number().int().nonnegative().optional(), waitMs: z.number().int().min(0).max(30_000).optional() }),
      annotations: { readOnlyHint: true }
    }, (input) => call("execution_wait", input));
    server.registerTool("execution_process_status", {
      description: "Read the original Process Host receipt for an owned execution, including after Core records an unknown result.",
      inputSchema: z.object({ id: z.string().min(1).max(160) }), annotations: { readOnlyHint: true }
    }, (input) => call("execution_process_status", input));
    server.registerTool("execution_process_output", {
      description: "Read a bounded base64 page of stdout or stderr by byte offset for an owned process execution.",
      inputSchema: z.object({ id: z.string().min(1).max(160), stream: z.enum(["stdout", "stderr"]).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional() }), annotations: { readOnlyHint: true }
    }, (input) => call("execution_process_output", input));
    server.registerTool("execution_events", {
      description: "Read a bounded page of durable execution events.",
      inputSchema: z.object({ id: z.string().min(1).max(160), afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true }
    }, (input) => call("execution_events", input));
    server.registerTool("execution_cancel", {
      description: "Request cancellation; the returned state distinguishes confirmed termination from pending recovery.",
      inputSchema: z.object({ id: z.string().min(1).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: true }
    }, (input) => call("execution_cancel", input));
    server.registerTool("core_status", {
      description: "Read the authenticated Core status.", inputSchema: z.object({}), annotations: { readOnlyHint: true }
    }, (input) => call("core_status", input));
    server.registerTool("capability_list", {
      description: "List capabilities available to this authenticated client.", inputSchema: z.object({}), annotations: { readOnlyHint: true }
    }, (input) => call("capability_list", input));
    server.registerTool("workflow_list", {
      description: "List locally installed and validated workflow revisions.", inputSchema: z.object({}), annotations: { readOnlyHint: true }
    }, (input) => call("workflow_list", input));
    server.registerTool("workflow_start", {
      description: "Create a durable workflow from a locally registered revision and explicit activation reason. Background advancement follows local configuration.",
      inputSchema: z.object({ workflowId: z.string().min(1).max(160), revision: z.string().min(1).max(160), input: z.json(), idempotencyKey: z.string().min(1).max(256), reason: z.string().min(1).max(4096) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    }, (input) => call("workflow_start", input));
    server.registerTool("workflow_scheduler_status", {
      description: "Read background workflow scheduler state, paused runs and bounded audit history.", inputSchema: z.object({}), annotations: { readOnlyHint: true }
    }, (input) => call("workflow_scheduler_status", input));
    server.registerTool("workflow_resume", {
      description: "Explicitly resume background observation of an owned paused workflow. Unknown external actions are never resubmitted.",
      inputSchema: z.object({ id: z.string().min(1).max(160) }), annotations: { readOnlyHint: false, destructiveHint: true }
    }, (input) => call("workflow_resume", input));
    for (const name of ["workflow_status", "workflow_tick", "workflow_cancel"] as const) server.registerTool(name, {
      description: name === "workflow_status" ? "Read a durable workflow without advancing it." : name === "workflow_tick" ? "Advance a bounded workflow step through the controlled executor; approvals remain required." : "Request cancellation of workflow-owned executions.",
      inputSchema: z.object({ id: z.string().min(1).max(160) }),
      annotations: { readOnlyHint: name === "workflow_status", destructiveHint: name !== "workflow_status" }
    }, (input) => call(name, input));
    // The Edge owns only its stdio connection. EOF never issues a Core shutdown.
    return server;
  }, {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 512 * 1024 }),
    maxSubscriptions: 16,
    onerror: () => process.stderr.write("V3 Edge protocol error.\n")
  });
} catch {
  process.stderr.write("V3 Edge configuration is invalid or unavailable.\n");
  process.exitCode = 1;
}
