import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { TerminalHost, outsideWorkspace } from './v3/terminal/host.js';
import { startRpcServer } from './v3/transport/rpc.js';
import { verifyConfigurationProtection, verifyStateProtection } from './v3/protection.js';

const absolute = z.string().refine(path.isAbsolute);
const schema = z.object({
  stateDir: absolute, workspaceRoot: absolute, clientTokenFile: absolute, operatorTokenFile: absolute,
  slot: z.string().min(1).max(160), principal: z.string().min(1).max(160), authorizationRevision: z.string().min(1).max(160),
  securityMode: z.literal('trusted-host'), port: z.number().int().min(0).max(65535).optional(),
  maxOutputBytes: z.number().int().positive().optional(), maxSessions: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().optional(), maxLifetimeMs: z.number().int().positive().optional(),
}).strict();
let host: TerminalHost | undefined, server: Awaited<ReturnType<typeof startRpcServer>> | undefined;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true;
  try { await server?.close(); } finally { await host?.close(); }
}
try {
  const configPath = process.env.P05_V3_TERMINAL_CONFIG;
  if (!configPath || !path.isAbsolute(configPath) || fs.statSync(configPath).size > 65536) throw new Error('Invalid config');
  if (!(await verifyStateProtection(path.dirname(configPath))).verified || !(await verifyConfigurationProtection(configPath)).verified) throw new Error('Unprotected config');
  const config = schema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  for (const file of [configPath, config.clientTokenFile, config.operatorTokenFile]) {
    outsideWorkspace(config.workspaceRoot, file);
    if (!(await verifyStateProtection(path.dirname(file))).verified || !(await verifyConfigurationProtection(file)).verified) throw new Error('Unprotected control file');
  }
  outsideWorkspace(config.workspaceRoot, config.stateDir);
  if (!(await verifyStateProtection(config.stateDir)).verified) throw new Error('Unprotected state');
  const token = (file: string) => { if (fs.statSync(file).size > 1024) throw new Error('Invalid token'); return fs.readFileSync(file, 'utf8').trim(); };
  host = new TerminalHost(config);
  server = await startRpcServer({ clientToken: token(config.clientTokenFile), operatorToken: token(config.operatorTokenFile), port: config.port, handle: (method, input, role) => host!.handle(method, input, role) });
  const endpoint = path.join(config.stateDir, 'endpoint.json'), temporary = endpoint + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, url: server.url, pid: process.pid, bootId: host.bootId, bindingDigest: host.health().bindingDigest }), { mode: 0o600 });
  fs.renameSync(temporary, endpoint);
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.stderr.write('P05_TERMINAL_HOST_READY\n');
} catch {
  process.stderr.write('Terminal Host configuration or startup failed.\n');
  try { await stop(); } finally { process.exitCode = 1; }
}
