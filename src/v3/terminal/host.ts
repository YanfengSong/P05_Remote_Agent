import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as z from 'zod/v4';
import type { RpcRole } from '../transport/rpc.js';

export interface TerminalHostOptions {
  stateDir: string; workspaceRoot: string; slot: string; principal: string;
  securityMode: 'trusted-host'; authorizationRevision: string;
  maxOutputBytes?: number; maxSessions?: number; maxConcurrent?: number; maxLifetimeMs?: number;
}
export interface TerminalView {
  id: string; state: 'REGISTERED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'EXITED' | 'UNKNOWN';
  bootId: string; expiresAt: number; storedBytes: number; observedBytes: number; truncated: boolean;
  cancelRequested: boolean; receipt: { exitCode?: number; signal?: number; reason?: string; directTermination: 'confirmed' | 'unconfirmed'; treeTermination: 'unconfirmed' } | null;
}
type Row = Record<string, unknown>;
export class TerminalError extends Error { constructor(readonly code: string) { super(code); } }
const intent = z.object({ intentId: z.string().min(1).max(160), authorizationRef: z.string().min(1).max(160) });
const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) };
const openSchema = intent.extend({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(64), ...dimensions }).strict();
const querySchema = z.object({ id: z.string().uuid() }).strict();
const mutation = intent.extend({ id: z.string().uuid() });
const inputSchema = mutation.extend({ data: z.string().min(1).max(4096) }).strict();
const resizeSchema = mutation.extend(dimensions).strict();
const outputSchema = querySchema.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(49152).default(49152) }).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bound(value: number | undefined, fallback: number, max: number): number { const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TerminalError('INVALID_LIMIT'); return n; }
export function outsideWorkspace(workspace: string, target: string): void {
  const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  const root = normalize(fs.realpathSync(workspace)), actual = normalize(fs.realpathSync(target));
  if (root === actual || root.startsWith(actual + path.sep) || actual.startsWith(root + path.sep)) throw new TerminalError('WORKSPACE_CONTROL_OVERLAP');
}
function runnerEnvironment(): NodeJS.ProcessEnv {
  // Deliberately exclude HOME/profile, NODE_OPTIONS, loader flags, proxies and all Core credentials.
  const names = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => names.has(key.toUpperCase()) && typeof value === 'string'));
}

/** Private trusted-host E4 service. This is neither an OS sandbox nor an approval engine. */
export class TerminalHost {
  readonly bootId = randomUUID();
  private readonly db: DatabaseSync;
  private readonly lock: DatabaseSync;
  private readonly options: TerminalHostOptions;
  private readonly outputLimit: number;
  private readonly sessionLimit: number;
  private readonly concurrency: number;
  private readonly lifetime: number;
  private readonly children = new Map<string, ChildProcess>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private closing = false;
  private faulted = false;
  private closingPromise?: Promise<void>;
  constructor(options: TerminalHostOptions) {
    if (options.securityMode !== 'trusted-host' || !path.isAbsolute(options.stateDir) || !path.isAbsolute(options.workspaceRoot)) throw new TerminalError('EXPLICIT_TRUSTED_HOST_REQUIRED');
    for (const text of [options.slot, options.principal, options.authorizationRevision]) if (!text || text.length > 160) throw new TerminalError('INVALID_IDENTITY');
    this.options = { ...options, stateDir: fs.realpathSync(options.stateDir), workspaceRoot: fs.realpathSync(options.workspaceRoot) };
    outsideWorkspace(this.options.workspaceRoot, this.options.stateDir);
    this.outputLimit = bound(options.maxOutputBytes, 1024 * 1024, 8 * 1024 * 1024);
    this.sessionLimit = bound(options.maxSessions, 64, 1024);
    this.concurrency = bound(options.maxConcurrent, 4, 16);
    this.lifetime = bound(options.maxLifetimeMs, 30 * 60 * 1000, 60 * 60 * 1000);
    this.lock = new DatabaseSync(path.join(this.options.stateDir, 'terminal-lock.sqlite'));
    try { this.lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
    catch { this.lock.close(); throw new TerminalError('HOST_ALREADY_RUNNING'); }
    try { this.db = new DatabaseSync(path.join(this.options.stateDir, 'terminals.sqlite')); }
    catch (error) { this.lock.close(); throw error; }
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      this.transaction(() => {
        if (Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version) > 1) throw new TerminalError('SCHEMA_VERSION_UNSUPPORTED');
        this.db.exec(`CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,open_key TEXT UNIQUE,digest TEXT NOT NULL,boot TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,stored INTEGER NOT NULL DEFAULT 0,observed INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0,cancel INTEGER NOT NULL DEFAULT 0,receipt TEXT);
          CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES sessions(id),operation TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS output(session TEXT NOT NULL REFERENCES sessions(id),offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(session,offset)); PRAGMA user_version=1;`);
        const identity = JSON.stringify([this.options.slot, this.options.principal, this.options.workspaceRoot, this.options.authorizationRevision]);
        const prior = this.db.prepare('SELECT value FROM binding WHERE id=1').get() as Row | undefined;
        if (prior && prior.value !== identity) throw new TerminalError('HOST_BINDING_MISMATCH');
        this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(identity);
        this.db.prepare("UPDATE sessions SET state='UNKNOWN',receipt=? WHERE state IN ('REGISTERED','RUNNING','CANCEL_REQUESTED')").run(JSON.stringify({ reason: 'TERMINAL_HOST_RESTART', directTermination: 'unconfirmed', treeTermination: 'unconfirmed' }));
        this.db.exec("UPDATE intents SET state='UNKNOWN' WHERE state='DISPATCHING'");
      });
    } catch (error) { this.db.close(); this.lock.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    let begun = false;
    try { this.db.exec('BEGIN IMMEDIATE'); begun = true; const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (begun) try { this.db.exec('ROLLBACK'); } catch { this.faulted = true; } if (!(error instanceof TerminalError)) this.faulted = true; throw error; }
  }
  private ensure(): void { if (this.closed || this.closing || this.faulted) throw new TerminalError('HOST_UNAVAILABLE'); }
  private row(id: string): Row { if (this.closed) throw new TerminalError('HOST_CLOSED'); const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined; if (!row) throw new TerminalError('TERMINAL_NOT_FOUND'); return row; }
  private view(row: Row): TerminalView { return { id: String(row.id), state: row.state as TerminalView['state'], bootId: String(row.boot), expiresAt: Number(row.expires), storedBytes: Number(row.stored), observedBytes: Number(row.observed), truncated: Boolean(row.truncated), cancelRequested: Boolean(row.cancel), receipt: row.receipt ? JSON.parse(String(row.receipt)) : null }; }
  open(raw: unknown): TerminalView {
    const input = openSchema.parse(raw); this.ensure();
    if (!path.isAbsolute(input.executable) || input.executable.includes('\0') || input.args.some(a => a.includes('\0')) || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new TerminalError('INVALID_COMMAND');
    const hash = digest(input), previous = this.db.prepare('SELECT * FROM sessions WHERE open_key=?').get(input.intentId) as Row | undefined;
    if (previous) { if (previous.digest !== hash) throw new TerminalError('INTENT_CONFLICT'); return this.view(previous); }
    if (this.children.size >= this.concurrency || Number((this.db.prepare('SELECT COUNT(*) n FROM sessions').get() as Row).n) >= this.sessionLimit) throw new TerminalError('CAPACITY_REACHED');
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare("INSERT INTO sessions(id,open_key,digest,boot,state,expires) VALUES(?,?,?,?,'REGISTERED',?)").run(id, input.intentId, hash, this.bootId, Date.now() + this.lifetime);
      this.db.prepare("INSERT INTO intents VALUES(?,?, 'open',?,?,'DISPATCHING',?)").run(input.intentId, id, hash, JSON.stringify(input), Date.now());
    });
    try {
      // No caller-supplied cwd/env, no inherited execArgv/NODE_OPTIONS or credential argv.
      const runner = fileURLToPath(new URL('./runner.js', import.meta.url));
      const child = fork(runner, [], { execArgv: [], env: runnerEnvironment(), cwd: this.options.workspaceRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      this.children.set(id, child);
      child.on('message', message => this.receive(id, message));
      child.once('error', () => this.unknown(id, 'RUNNER_FAILED'));
      child.once('exit', () => { this.children.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id); try { if (!this.closed && !['EXITED', 'UNKNOWN'].includes(String(this.row(id).state))) this.unknown(id, 'RUNNER_EXIT_WITHOUT_RECEIPT'); } catch { this.faulted = true; } });
      child.send({ kind: 'start', executable: input.executable, args: input.args, cwd: this.options.workspaceRoot, cols: input.cols, rows: input.rows }, error => { if (error) this.unknown(id, 'DISPATCH_UNCONFIRMED'); });
      this.timers.set(id, setTimeout(() => { try { this.cancel({ id, intentId: randomUUID(), authorizationRef: 'host-expiry' }); } catch { this.unknown(id, 'EXPIRY_UNCONFIRMED'); } }, this.lifetime));
    } catch { this.unknown(id, 'DISPATCH_UNCONFIRMED'); }
    return this.view(this.row(id));
  }
  private receive(id: string, raw: unknown): void {
    if (this.closed || this.faulted) return;
    const message = raw as { kind: string; data: string; bytes: number; exitCode: number; signal?: number; intentId: string };
    try {
      if (message.kind === 'output') this.capture(id, Buffer.from(message.data, 'utf8'));
      else if (message.kind === 'dropped') this.db.prepare('UPDATE sessions SET observed=observed+?,truncated=1 WHERE id=?').run(message.bytes, id);
      else if (message.kind === 'started') this.transaction(() => {
        this.db.prepare("UPDATE sessions SET state='RUNNING' WHERE id=? AND state='REGISTERED'").run(id);
        this.db.prepare("UPDATE intents SET state='ACCEPTED' WHERE session=? AND operation='open'").run(id);
      });
      else if (message.kind === 'ack') this.db.prepare("UPDATE intents SET state='ACCEPTED' WHERE id=? AND session=? AND state='DISPATCHING'").run(message.intentId, id);
      else if (message.kind === 'exit') this.db.prepare('UPDATE sessions SET state=?,receipt=? WHERE id=?').run(Number.isInteger(message.exitCode) ? 'EXITED' : 'UNKNOWN', JSON.stringify({ exitCode: message.exitCode, ...(message.signal === undefined ? {} : { signal: message.signal }), directTermination: Number.isInteger(message.exitCode) ? 'confirmed' : 'unconfirmed', treeTermination: 'unconfirmed' }), id);
      else if (message.kind === 'uncertain') this.unknown(id, 'PTY_OPERATION_UNCONFIRMED');
    } catch { this.faulted = true; }
  }
  private capture(id: string, data: Buffer): void {
    this.transaction(() => {
      const row = this.row(id), offset = Number(row.stored);
      const total = Number((this.db.prepare('SELECT COALESCE(SUM(stored),0) n FROM sessions').get() as Row).n);
      const length = Math.max(0, Math.min(data.length, this.outputLimit - offset, 64 * 1024 * 1024 - total));
      for (let taken = 0; taken < length;) {
        const pageOffset = Math.floor((offset + taken) / 4096) * 4096;
        const prior = this.db.prepare('SELECT bytes FROM output WHERE session=? AND offset=?').get(id, pageOffset) as { bytes: Uint8Array } | undefined;
        const prefix = prior ? Buffer.from(prior.bytes) : Buffer.alloc(0);
        const count = Math.min(4096 - prefix.length, length - taken);
        this.db.prepare('INSERT INTO output VALUES(?,?,?) ON CONFLICT(session,offset) DO UPDATE SET bytes=excluded.bytes').run(id, pageOffset, Buffer.concat([prefix, data.subarray(taken, taken + count)]));
        taken += count;
      }
      this.db.prepare('UPDATE sessions SET stored=stored+?,observed=observed+?,truncated=MAX(truncated,?) WHERE id=?').run(length, data.length, Number(length < data.length), id);
    });
  }
  private unknown(id: string, reason: string): void {
    if (this.closed) return;
    try { this.transaction(() => {
      this.db.prepare("UPDATE sessions SET state='UNKNOWN',receipt=? WHERE id=? AND state!='EXITED'").run(JSON.stringify({ reason, directTermination: 'unconfirmed', treeTermination: 'unconfirmed' }), id);
      this.db.prepare("UPDATE intents SET state='UNKNOWN' WHERE session=? AND state='DISPATCHING'").run(id);
    }); } catch { this.faulted = true; }
  }
  status(raw: unknown): TerminalView { return this.view(this.row(querySchema.parse(raw).id)); }
  output(raw: unknown) {
    const input = outputSchema.parse(raw), row = this.row(input.id), available = Number(row.stored);
    if (input.offset > available) throw new TerminalError('INVALID_CURSOR');
    const chunks = this.db.prepare('SELECT offset,bytes FROM output WHERE session=? AND offset<? AND offset+length(bytes)>? ORDER BY offset').all(input.id, input.offset + input.limit, input.offset) as Array<{ offset: number; bytes: Uint8Array }>;
    const bytes = chunks.length ? Buffer.concat(chunks.map(c => Buffer.from(c.bytes))).subarray(input.offset - chunks[0]!.offset, input.offset - chunks[0]!.offset + input.limit) : Buffer.alloc(0);
    return { id: input.id, offset: input.offset, nextOffset: input.offset + bytes.length, dataBase64: bytes.toString('base64'), availableBytes: available, observedBytes: Number(row.observed), truncated: Boolean(row.truncated), stream: 'terminal' };
  }
  private effect(operation: string, input: { id: string; intentId: string; authorizationRef: string; [key: string]: unknown }) {
    this.ensure(); const row = this.row(input.id), hash = digest([operation, input]);
    const old = this.db.prepare('SELECT * FROM intents WHERE id=?').get(input.intentId) as Row | undefined;
    if (old) { if (old.session !== input.id || old.digest !== hash) throw new TerminalError('INTENT_CONFLICT'); return { intentId: input.intentId, state: String(old.state) }; }
    const child = this.children.get(input.id);
    if (!child?.connected || !(operation === 'cancel' ? ['REGISTERED', 'RUNNING', 'UNKNOWN'] : ['REGISTERED', 'RUNNING']).includes(String(row.state)) || (operation !== 'cancel' && Date.now() >= Number(row.expires))) throw new TerminalError('TERMINAL_NOT_WRITABLE');
    if (operation !== 'cancel' && Number((this.db.prepare('SELECT COUNT(*) n FROM intents WHERE session=?').get(input.id) as Row).n) >= 256) throw new TerminalError('INTENT_CAPACITY_REACHED');
    this.transaction(() => {
      this.db.prepare("INSERT INTO intents VALUES(?,?,?,?,?,'DISPATCHING',?)").run(input.intentId, input.id, operation, hash, JSON.stringify(input), Date.now());
      if (operation === 'cancel') this.db.prepare("UPDATE sessions SET state=CASE WHEN state='UNKNOWN' THEN state ELSE 'CANCEL_REQUESTED' END,cancel=1 WHERE id=?").run(input.id);
    });
    try { child.send({ ...input, kind: operation }, error => { if (error) this.unknown(input.id, 'EFFECT_ACK_UNCONFIRMED'); }); }
    catch { this.unknown(input.id, 'EFFECT_ACK_UNCONFIRMED'); }
    if (operation === 'cancel') {
      clearTimeout(this.timers.get(input.id));
      this.timers.set(input.id, setTimeout(() => {
        if (this.children.get(input.id) === child) { this.unknown(input.id, 'CANCEL_EXIT_UNCONFIRMED'); child.kill(); }
      }, 1500));
    }
    return { intentId: input.intentId, state: 'DISPATCHING' };
  }
  input(raw: unknown) { const input = inputSchema.parse(raw); if (Buffer.byteLength(input.data) > 4096) throw new TerminalError('INPUT_TOO_LARGE'); return this.effect('input', input); }
  resize(raw: unknown) { return this.effect('resize', resizeSchema.parse(raw)); }
  cancel(raw: unknown) { return this.effect('cancel', mutation.strict().parse(raw)); }
  intentStatus(raw: unknown) { const input = z.object({ id: z.string().uuid(), intentId: z.string().min(1).max(160) }).strict().parse(raw); this.row(input.id); const record = this.db.prepare('SELECT operation,state,at,digest FROM intents WHERE id=? AND session=?').get(input.intentId, input.id); if (!record) throw new TerminalError('INTENT_NOT_FOUND'); return record; }
  health() { if (!this.closed) try { this.db.prepare('SELECT 1').get(); } catch { this.faulted = true; } return { alive: !this.closed, available: !this.closed && !this.closing && !this.faulted, storageFault: this.faulted, bootId: this.bootId, bindingDigest: digest([this.options.slot, this.options.principal, this.options.workspaceRoot, this.options.authorizationRevision]), activeSessions: this.children.size, securityMode: 'trusted-host', filesystemIsolation: false, networkIsolation: false, treeTermination: 'unconfirmed' }; }
  async handle(method: string, raw: unknown, role: RpcRole): Promise<unknown> {
    try {
      if (role !== 'client') throw new TerminalError('FORBIDDEN');
      switch (method) {
        case 'terminal_open': return this.open(raw);
        case 'terminal_status': case 'terminal_attach': return this.status(raw);
        case 'terminal_output': return this.output(raw);
        case 'terminal_input': return this.input(raw);
        case 'terminal_resize': return this.resize(raw);
        case 'terminal_cancel': return this.cancel(raw);
        case 'terminal_intent_status': return this.intentStatus(raw);
        case 'terminal_health': return this.health();
        default: throw new TerminalError('METHOD_NOT_FOUND');
      }
    } catch (error) { if (!(error instanceof TerminalError) && !(error instanceof z.ZodError)) this.faulted = true; return { error: { code: error instanceof TerminalError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'TERMINAL_STORAGE_ERROR' } }; }
  }
  close(): Promise<void> { return this.closingPromise ??= this.stop(); }
  private async stop(): Promise<void> {
    this.closing = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const [id, child] of this.children) { this.unknown(id, 'HOST_STOPPED'); try { child.send({ kind: 'cancel' }); } catch { /* uncertain */ } }
    const end = Date.now() + 1500;
    while (this.children.size && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    for (const child of this.children.values()) { child.kill(); if (child.connected) child.disconnect(); }
    this.closed = true; this.db.close(); this.lock.close();
  }
}
