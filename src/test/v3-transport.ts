import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startRpcServer, createRpcClient, RpcError } from "../v3/transport/rpc.js";

const clientToken = randomBytes(32).toString("hex");
const operatorToken = randomBytes(32).toString("hex");
const calls: { method: string; role: string; input: unknown }[] = [];
let release: (() => void) | undefined;
let entered: (() => void) | undefined;
let finished = 0;
const server = await startRpcServer({
  clientToken, operatorToken, maxRequestBytes: 512, maxResponseBytes: 1024, maxConcurrent: 1,
  async handle(method, input, role) {
    calls.push({ method, input, role });
    if (method === "secret_error") throw new Error(`secret path C:\\private ${operatorToken}`);
    if (method === "oversize") return { data: "x".repeat(2048) };
    if (method === "blocking") {
      await new Promise<void>((resolve) => { release = resolve; entered?.(); });
      finished += 1;
    }
    return { method, role, input, finished };
  }
});

async function request(options: {
  token?: string; host?: string; origin?: string; body?: string; chunked?: boolean; path?: string; method?: string;
} = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(server.url + (options.path ?? "/rpc"), {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.chunked ? { "transfer-encoding": "chunked" } : {})
      }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (part) => { text += part; });
      response.on("end", () => resolve({ status: response.statusCode!, text }));
    });
    req.on("error", reject);
    req.end(options.body ?? JSON.stringify({ method: "inspect", input: {} }));
  });
}

try {
  assert.deepEqual(await request({ method: "GET", path: "/health" }), { status: 200, text: '{"alive":true}' });
  assert.equal((await request()).status, 401);
  assert.equal((await request({ token: "x".repeat(64) })).status, 401);
  assert.equal((await request({ token: clientToken, host: "evil.example" })).status, 403);
  assert.equal((await request({ token: clientToken, origin: "https://evil.example" })).status, 403);
  assert.equal((await request({ token: clientToken, origin: "null" })).status, 403);
  assert.equal((await request({ token: clientToken, origin: server.url })).status, 200);
  assert.equal((await request({ token: clientToken, body: JSON.stringify({ method: "inspect", input: {}, role: "operator" }) })).status, 400);
  const client = createRpcClient({ url: server.url, token: clientToken });
  const operator = createRpcClient({ url: server.url, token: operatorToken });
  assert.equal((await client.call("inspect", { role: "operator" }) as { role: string }).role, "client");
  assert.equal((await operator.call("inspect", {}) as { role: string }).role, "operator");
  assert.equal((await request({ token: clientToken, body: "bad json" })).status, 400);
  assert.equal((await request({ token: clientToken, body: "x".repeat(2048) })).status, 413);
  assert.equal((await request({ token: clientToken, body: "x".repeat(2048), chunked: true })).status, 413);
  await assert.rejects(client.call("oversize"), (error) => error instanceof RpcError && error.code === "RESPONSE_TOO_LARGE");
  const redacted = await request({ token: clientToken, body: JSON.stringify({ method: "secret_error" }) });
  assert.equal(redacted.status, 500);
  assert.equal(redacted.text.includes(operatorToken), false);
  assert.equal(redacted.text.includes("private"), false);

  for (const url of ["https://127.0.0.1:1", "http://localhost:1", "http://evil.example", "http://127.0.0.1:1/rpc", "http://user:password@127.0.0.1:1", "http://127.0.0.1:1/?token=secret"]) {
    assert.throws(() => createRpcClient({ url, token: clientToken }), /INVALID_ENDPOINT/);
  }

  // Confirm the handler accepted the request before the transport wait expires.
  const accepted = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = client.call("blocking", {}, { timeoutMs: 250 });
  const timeoutResult = assert.rejects(waiting, (error) => error instanceof RpcError && error.code === "WAIT_TIMEOUT");
  await accepted;
  assert.equal((await request({ token: clientToken })).status, 429);
  // Reserved liveness remains reachable while execution consumes capacity.
  assert.equal((await request({ method: "GET", path: "/health" })).status, 200);
  await timeoutResult;
  assert.equal(finished, 0);
  release!();
  // A query only succeeds after the first handler releases its concurrency slot.
  let result: { finished: number } | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { result = await client.call("inspect", {}) as { finished: number }; break; }
    catch (error) {
      if (!(error instanceof RpcError) || error.code !== "BUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(result?.finished, 1, "client disconnection must not cancel the accepted handler");
  assert.equal(calls.filter((call) => call.method === "blocking").length, 1);

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p05-v3-edge-"));
  const tokenFile = path.join(fixtureRoot, "client-token");
  fs.writeFileSync(tokenFile, clientToken, { mode: 0o600 });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_") && !key.startsWith("REMOTE_AGENT_")) environment[key] = value;
  }
  Object.assign(environment, {
    P05_V3_ENDPOINT: server.url,
    P05_V3_CLIENT_TOKEN_FILE: tokenFile,
    P05_V3_CLIENT_TOKEN: "x".repeat(64)
  });
  const mcp = new Client({ name: "v3-edge-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...process.execArgv, fileURLToPath(new URL("../v3-edge.js", import.meta.url))],
    env: environment, stderr: "pipe"
  });
  let edgeErrors = "";
  transport.stderr?.on("data", (part) => { edgeErrors += String(part); });
  try {
    await mcp.connect(transport);
    const listed = await mcp.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "capability_list", "core_status", "execution_cancel", "execution_events", "execution_process_output", "execution_process_status", "execution_status", "execution_submit", "execution_wait",
      "workflow_cancel", "workflow_list", "workflow_resume", "workflow_scheduler_status", "workflow_start", "workflow_status", "workflow_tick"
    ]);
    const status = await mcp.callTool({ name: "core_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const statusData = status.structuredContent as Record<string, unknown> | undefined;
    assert.equal(statusData?.role, "client", "credential file wins over conflicting environment credential");
    const submitted = await mcp.callTool({
      name: "execution_submit", arguments: { capability: "probe", input: { payload: 1 }, idempotencyKey: "one" }
    });
    const submittedData = submitted.structuredContent as Record<string, unknown> | undefined;
    assert.deepEqual(submittedData?.input, { capability: "probe", input: { payload: 1 }, idempotencyKey: "one" });
    assert.equal(listed.tools.some((tool) => tool.name.includes("approval")), false);
    assert.equal(edgeErrors.includes(clientToken) || edgeErrors.includes(operatorToken), false);
  } finally {
    await mcp.close();
    assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureRoot).startsWith("p05-v3-edge-"));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  assert.equal((await client.call("inspect", {}) as { role: string }).role, "client", "closing the Edge leaves Core alive");
  console.log("V3_TRANSPORT_OK (HTTP security/bounds, disconnect survival, real stdio MCP, token-file precedence, Core survives Edge closure)");
} finally {
  release?.();
  await server.close();
}
