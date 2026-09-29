import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { ProcessExecutionHost } from "./v3/process/host.js";
import { startRpcServer } from "./v3/transport/rpc.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./v3/protection.js";

const absolutePath = z.string().refine(path.isAbsolute);
const schema = z.object({
  stateDir: absolutePath, workspaceRoot: absolutePath, slot: z.string().min(1).max(80), principal: z.string().min(1).max(160),
  securityMode: z.literal("trusted-host"), clientTokenFile: absolutePath, operatorTokenFile: absolutePath,
  port: z.number().int().min(0).max(65535).optional(), maxOutputBytes: z.number().int().positive().optional(),
  maxStoredOutputBytes: z.number().int().positive().optional(), maxProcesses: z.number().int().positive().optional(), maxConcurrent: z.number().int().positive().optional()
}).strict();

let host: ProcessExecutionHost | undefined;
let server: Awaited<ReturnType<typeof startRpcServer>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await server?.close(); await host?.close(); }
  catch { process.stderr.write("Process Host shutdown requires recovery.\n"); process.exitCode = 1; }
}
try {
  const configFile = process.env.P05_V3_PROCESS_CONFIG;
  if (!configFile || !path.isAbsolute(configFile) || fs.statSync(configFile).size > 64 * 1024) throw new Error("Invalid configuration.");
  if (!(await verifyStateProtection(path.dirname(configFile))).verified || !(await verifyConfigurationProtection(configFile)).verified) throw new Error("Unprotected configuration.");
  const config = schema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  if (!(await verifyStateProtection(config.stateDir)).verified) throw new Error("Unprotected executor state.");
  for (const file of [config.clientTokenFile, config.operatorTokenFile]) {
    if (!(await verifyStateProtection(path.dirname(file))).verified || !(await verifyConfigurationProtection(file)).verified) throw new Error("Unprotected executor credential.");
  }
  const readToken = (file: string) => {
    if (fs.statSync(file).size > 1024) throw new Error("Invalid credential.");
    return fs.readFileSync(file, "utf8").trim();
  };
  host = new ProcessExecutionHost(config);
  server = await startRpcServer({ clientToken: readToken(config.clientTokenFile), operatorToken: readToken(config.operatorTokenFile), port: config.port, handle: (method, input, role) => host!.handle(method, input, role) });
  const metadata = path.join(config.stateDir, "endpoint.json");
  const temp = metadata + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, url: server.url, pid: process.pid, executorBootId: host.bootId }), { mode: 0o600 });
  fs.renameSync(temp, metadata);
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  // This process has its own lifetime; parent/Core stdio EOF has no significance.
  process.stderr.write("P05_PROCESS_HOST_READY\n");
} catch {
  process.stderr.write("Process Host configuration or startup failed.\n");
  await stop();
  process.exitCode = 1;
}
