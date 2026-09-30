import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import type { RpcRole } from "../transport/rpc.js";
import { StreamingSecretRedactor, redactSecretText } from "../secrets.js";

export type ProcessOwner = { slot: string; principal: string; runId: string; attemptId: string };
export type ProcessHostOptions = {
  stateDir: string; workspaceRoot: string; slot: string; principal: string; securityMode: "trusted-host";
  maxOutputBytes?: number; maxStoredOutputBytes?: number; maxProcesses?: number; maxConcurrent?: number;
};
export type ProcessReceipt = {
  kind: "exit" | "spawn_failed" | "unknown";
  executorBootId: string; at: number; exitCode?: number | null; signal?: string | null;
  directTermination: "confirmed" | "unconfirmed"; treeTermination: "unconfirmed"; cancelRequested: boolean;
  reason?: string;
};
export type ProcessView = {
  id: string; dispatchKey: string; inputDigest: string; owner: ProcessOwner; executorBootId: string;
  state: "REGISTERED" | "RUNNING" | "CANCEL_REQUESTED" | "EXITED" | "FAILED" | "UNKNOWN";
  stdoutBytes: number; stderrBytes: number; truncated: boolean; receipt?: ProcessReceipt;
};
type Row = Record<string, unknown>;
const ownerSchema = z.object({ slot: z.string().min(1).max(80), principal: z.string().min(1).max(160), runId: z.string().min(1).max(160), attemptId: z.string().min(1).max(160) }).strict();
const submitSchema = z.object({ dispatchKey: z.string().min(1).max(256), owner: ownerSchema, executable: z.string().min(1).max(4096), args: z.array(z.string().max(32768)).max(256), redactions: z.array(z.string().min(4).max(4096)).max(64).default([]) }).strict();
const querySchema = z.object({ id: z.string().uuid(), owner: ownerSchema }).strict();
const outputSchema = querySchema.extend({ stream: z.enum(["stdout", "stderr"]).default("stdout"), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(65536).default(65536) }).strict();
const PAGE_BYTES = 4096;

export class ProcessHostError extends Error {
  constructor(readonly code: string) { super(code); }
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ProcessHostError("INVALID_LIMIT");
  return result;
}
function childEnvironment(): NodeJS.ProcessEnv {
  const names = new Set(["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => names.has(key.toUpperCase()) && typeof value === "string"));
}

/** Durable root-process receipts. This backend supplies NO OS filesystem/network sandbox. */
export class ProcessExecutionHost {
  readonly bootId = randomUUID();
  readonly #options: ProcessHostOptions;
  readonly #db: DatabaseSync;
  readonly #ownerLock: DatabaseSync;
  readonly #maxOutput: number;
  readonly #maxStoredOutput: number;
  readonly #maxProcesses: number;
  readonly #maxConcurrent: number;
  readonly #children = new Map<string, ChildProcess>();
  readonly #scheduled = new Set<string>();
  readonly #redactors = new Map<string, { stdout: StreamingSecretRedactor; stderr: StreamingSecretRedactor }>();
  #closing = false;
  #closed = false;
  #faulted = false;
  #closePromise?: Promise<void>;

  constructor(options: ProcessHostOptions) {
    if (options.securityMode !== "trusted-host" || !path.isAbsolute(options.stateDir) || !path.isAbsolute(options.workspaceRoot)) {
      throw new ProcessHostError("EXPLICIT_TRUSTED_HOST_CONFIGURATION_REQUIRED");
    }
    ownerSchema.parse({ slot: options.slot, principal: options.principal, runId: "config", attemptId: "config" });
    this.#options = { ...options, workspaceRoot: fs.realpathSync(options.workspaceRoot), stateDir: path.resolve(options.stateDir) };
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const workspace = normalize(this.#options.workspaceRoot);
    const state = normalize(this.#options.stateDir);
    if (state === workspace || state.startsWith(workspace + path.sep) || workspace.startsWith(state + path.sep)) throw new ProcessHostError("STATE_WORKSPACE_OVERLAP");
    this.#maxOutput = bounded(options.maxOutputBytes, 20 * 1024 * 1024, 20 * 1024 * 1024);
    this.#maxStoredOutput = bounded(options.maxStoredOutputBytes, 200 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
    this.#maxProcesses = bounded(options.maxProcesses, 1000, 100_000);
    this.#maxConcurrent = bounded(options.maxConcurrent, 8, 64);
    fs.mkdirSync(this.#options.stateDir, { recursive: true, mode: 0o700 });
    const actualState = normalize(fs.realpathSync(this.#options.stateDir));
    if (actualState === workspace || actualState.startsWith(workspace + path.sep) || workspace.startsWith(actualState + path.sep)) throw new ProcessHostError("STATE_WORKSPACE_OVERLAP");
    // A separate rollback-journal database holds an OS-backed lock throughout the
    // host lifetime. It is never unlinked/reclaimed based on a PID or a clock.
    const lockPath = path.join(this.#options.stateDir, "owner-lock.sqlite");
    this.#ownerLock = new DatabaseSync(lockPath);
    try {
      if (process.platform !== "win32") fs.chmodSync(lockPath, 0o600);
      this.#ownerLock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
    } catch {
      this.#ownerLock.close();
      throw new ProcessHostError("HOST_ALREADY_RUNNING");
    }
    const databasePath = path.join(this.#options.stateDir, "processes.sqlite");
    try { this.#db = new DatabaseSync(databasePath); }
    catch (error) { this.#ownerLock.close(); throw error; }
    try {
      if (process.platform !== "win32") fs.chmodSync(databasePath, 0o600);
      this.#db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      this.#transaction(() => {
        const version = Number((this.#db.prepare("PRAGMA user_version").get() as Row).user_version);
        if (version > 1) throw new ProcessHostError("SCHEMA_VERSION_UNSUPPORTED");
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS host_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding TEXT NOT NULL,pid INTEGER,boot TEXT);
          CREATE TABLE IF NOT EXISTS processes(id TEXT PRIMARY KEY,dispatch_key TEXT UNIQUE NOT NULL,input_digest TEXT NOT NULL,owner TEXT NOT NULL,input TEXT NOT NULL,boot TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0,stdout_bytes INTEGER NOT NULL DEFAULT 0,stderr_bytes INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS output_pages(process_id TEXT NOT NULL REFERENCES processes(id),stream TEXT NOT NULL,page INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(process_id,stream,page));
          CREATE TABLE IF NOT EXISTS receipts(process_id TEXT PRIMARY KEY REFERENCES processes(id),payload TEXT NOT NULL);
          PRAGMA user_version=1;
        `);
        const binding = JSON.stringify([this.#options.slot, this.#options.principal, this.#options.workspaceRoot]);
        const current = this.#db.prepare("SELECT * FROM host_identity WHERE singleton=1").get() as Row | undefined;
        if (current && current.binding !== binding) throw new ProcessHostError("HOST_BINDING_MISMATCH");
        this.#db.prepare("INSERT INTO host_identity(singleton,binding,pid,boot) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,boot=excluded.boot").run(binding, process.pid, this.bootId);
        for (const row of this.#db.prepare("SELECT * FROM processes WHERE state IN ('REGISTERED','RUNNING','CANCEL_REQUESTED')").all() as Row[]) {
          const receipt: ProcessReceipt = { kind: "unknown", executorBootId: String(row.boot), at: Date.now(), directTermination: "unconfirmed", treeTermination: "unconfirmed", cancelRequested: Boolean(row.cancel_requested), reason: "EXECUTOR_RESTART" };
          this.#db.prepare("UPDATE processes SET state='UNKNOWN',updated=? WHERE id=?").run(Date.now(), String(row.id));
          this.#db.prepare("INSERT OR IGNORE INTO receipts(process_id,payload) VALUES(?,?)").run(String(row.id), JSON.stringify(receipt));
        }
      });
    } catch (error) { this.#db.close(); this.#ownerLock.close(); throw error; }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.#db.exec("COMMIT"); return value; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #checkOwner(owner: ProcessOwner): string {
    if (owner.slot !== this.#options.slot || owner.principal !== this.#options.principal) throw new ProcessHostError("OWNER_MISMATCH");
    return JSON.stringify([owner.slot, owner.principal, owner.runId, owner.attemptId]);
  }

  #row(id: string, owner: ProcessOwner): Row {
    const identity = this.#checkOwner(owner);
    const row = this.#db.prepare("SELECT * FROM processes WHERE id=?").get(id) as Row | undefined;
    if (!row || row.owner !== identity) throw new ProcessHostError("PROCESS_NOT_FOUND");
    return row;
  }

  #view(row: Row): ProcessView {
    const [slot, principal, runId, attemptId] = JSON.parse(String(row.owner)) as string[];
    const receipt = this.#db.prepare("SELECT payload FROM receipts WHERE process_id=?").get(String(row.id)) as Row | undefined;
    return {
      id: String(row.id), dispatchKey: String(row.dispatch_key), inputDigest: String(row.input_digest),
      owner: { slot: slot!, principal: principal!, runId: runId!, attemptId: attemptId! }, executorBootId: String(row.boot),
      state: row.state as ProcessView["state"], stdoutBytes: Number(row.stdout_bytes), stderrBytes: Number(row.stderr_bytes), truncated: Boolean(row.truncated),
      ...(receipt ? { receipt: JSON.parse(String(receipt.payload)) as ProcessReceipt } : {})
    };
  }

  submit(raw: unknown): ProcessView {
    const input = submitSchema.parse(raw);
    const identity = this.#checkOwner(input.owner);
    if (!path.isAbsolute(input.executable) || input.executable.includes("\0") || input.args.some((argument) => argument.includes("\0"))) throw new ProcessHostError("INVALID_COMMAND");
    const payload = JSON.stringify([input.executable, input.args, this.#options.workspaceRoot, identity]);
    if (Buffer.byteLength(payload) > 256 * 1024) throw new ProcessHostError("INPUT_TOO_LARGE");
    const digest = createHash("sha256").update(payload).digest("hex");
    const previous = this.#db.prepare("SELECT * FROM processes WHERE dispatch_key=?").get(input.dispatchKey) as Row | undefined;
    if (previous) {
      if (previous.owner !== identity) throw new ProcessHostError("OWNER_MISMATCH");
      if (previous.input_digest !== digest) throw new ProcessHostError("DISPATCH_CONFLICT");
      return this.#view(previous);
    }
    if (this.#closing || this.#faulted) throw new ProcessHostError("HOST_UNAVAILABLE");
    if (this.#children.size + this.#scheduled.size >= this.#maxConcurrent) throw new ProcessHostError("HOST_BUSY");
    if (Number((this.#db.prepare("SELECT COUNT(*) AS n FROM processes").get() as Row).n) >= this.#maxProcesses) throw new ProcessHostError("RECEIPT_CAPACITY_REACHED");
    const id = randomUUID();
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO processes(id,dispatch_key,input_digest,owner,input,boot,state,created,updated) VALUES(?,?,?,?,?,?,'REGISTERED',?,?)")
        .run(id, input.dispatchKey, digest, identity, JSON.stringify({ executable: input.executable, args: input.args.map(argument => redactSecretText(argument, input.redactions)) }), this.bootId, Date.now(), Date.now());
    });
    this.#scheduled.add(id);
    // The durable acceptance exists before spawn; requests do not wait for process completion.
    setImmediate(() => { this.#scheduled.delete(id); if (!this.#closing && !this.#faulted) this.#dispatch(id, input.executable, input.args, input.redactions); });
    return this.#view(this.#row(id, input.owner));
  }

  #dispatch(id: string, executable: string, args: string[], redactions: string[]): void {
    try {
      // Persist intent before crossing the non-transactional OS boundary.
      this.#db.prepare("UPDATE processes SET state='RUNNING',updated=? WHERE id=? AND state='REGISTERED'").run(Date.now(), id);
      const current = this.#db.prepare("SELECT state FROM processes WHERE id=?").get(id) as Row;
      if (current.state !== "RUNNING") return;
      const child = spawn(executable, args, { cwd: this.#options.workspaceRoot, env: childEnvironment(), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let finalEvidence: (Pick<ProcessReceipt, "kind" | "directTermination"> & Partial<ProcessReceipt>) | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      this.#children.set(id, child);
      const outputRedactors = { stdout: new StreamingSecretRedactor(redactions), stderr: new StreamingSecretRedactor(redactions) };
      this.#redactors.set(id, outputRedactors);
      child.stdout?.on("data", (chunk: Buffer) => { const safe = outputRedactors.stdout.push(chunk); if (safe.length) this.#capture(id, "stdout", safe); });
      child.stderr?.on("data", (chunk: Buffer) => { const safe = outputRedactors.stderr.push(chunk); if (safe.length) this.#capture(id, "stderr", safe); });
      child.once("spawn", () => {
        try { this.#db.prepare("UPDATE processes SET pid=?,updated=? WHERE id=?").run(child.pid!, Date.now(), id); }
        catch { this.#faulted = true; }
      });
      child.once("error", () => { finalEvidence = { kind: "spawn_failed", reason: "SPAWN_FAILED", directTermination: "confirmed" }; });
      child.once("exit", (exitCode, signal) => {
        finalEvidence = { kind: "exit", exitCode, signal, directTermination: "confirmed" };
        // A descendant can retain inherited pipes after the root exits. Do not wait
        // forever or claim tree termination; mark incomplete output explicitly.
        drainTimer = setTimeout(() => {
          try { if (!this.#closed) this.#db.prepare("UPDATE processes SET truncated=1 WHERE id=?").run(id); }
          catch { this.#faulted = true; }
          finalEvidence = { ...finalEvidence!, reason: "OUTPUT_DRAIN_TIMEOUT" };
          child.stdout?.destroy(); child.stderr?.destroy();
        }, 5000);
      });
      child.once("close", () => {
        if (drainTimer) clearTimeout(drainTimer);
        const redactors = this.#redactors.get(id);
        if (redactors) {
          const stdout = redactors.stdout.flush(), stderr = redactors.stderr.flush();
          if (stdout.length) this.#capture(id, "stdout", stdout);
          if (stderr.length) this.#capture(id, "stderr", stderr);
          this.#redactors.delete(id);
        }
        this.#finish(id, finalEvidence ?? { kind: "unknown", directTermination: "unconfirmed", reason: "EXIT_EVIDENCE_MISSING" });
        this.#children.delete(id);
      });
    } catch {
      this.#redactors.delete(id);
      this.#finish(id, { kind: "unknown", reason: "DISPATCH_FAILED", directTermination: "unconfirmed" });
    }
  }

  #capture(id: string, stream: "stdout" | "stderr", data: Buffer): void {
    if (this.#closed || this.#faulted) return;
    try {
      this.#transaction(() => {
        const row = this.#db.prepare("SELECT stdout_bytes,stderr_bytes FROM processes WHERE id=?").get(id) as Row;
        const stored = Number((this.#db.prepare("SELECT COALESCE(SUM(stdout_bytes+stderr_bytes),0) AS n FROM processes").get() as Row).n);
        const length = Math.min(data.length, this.#maxOutput - Number(row.stdout_bytes) - Number(row.stderr_bytes), this.#maxStoredOutput - stored);
        const offset = Number(row[stream + "_bytes"]);
        if (length < data.length) this.#db.prepare("UPDATE processes SET truncated=1 WHERE id=?").run(id);
        for (let taken = 0; taken < length;) {
          const page = Math.floor((offset + taken) / PAGE_BYTES);
          const old = this.#db.prepare("SELECT bytes FROM output_pages WHERE process_id=? AND stream=? AND page=?").get(id, stream, page) as { bytes: Uint8Array } | undefined;
          const prefix = old ? Buffer.from(old.bytes) : Buffer.alloc(0);
          const count = Math.min(PAGE_BYTES - prefix.length, length - taken);
          const bytes = Buffer.concat([prefix, data.subarray(taken, taken + count)]);
          this.#db.prepare("INSERT INTO output_pages(process_id,stream,page,bytes) VALUES(?,?,?,?) ON CONFLICT(process_id,stream,page) DO UPDATE SET bytes=excluded.bytes").run(id, stream, page, bytes);
          taken += count;
        }
        this.#db.prepare(`UPDATE processes SET ${stream}_bytes=${stream}_bytes+?,updated=? WHERE id=?`).run(Math.max(length, 0), Date.now(), id);
      });
    } catch { this.#faulted = true; }
  }

  #finish(id: string, detail: Pick<ProcessReceipt, "kind" | "directTermination"> & Partial<ProcessReceipt>): void {
    if (this.#closed) return;
    try {
      this.#transaction(() => {
        if (this.#db.prepare("SELECT 1 FROM receipts WHERE process_id=?").get(id)) return;
        const row = this.#db.prepare("SELECT cancel_requested FROM processes WHERE id=?").get(id) as Row;
        const receipt: ProcessReceipt = { ...detail, executorBootId: this.bootId, at: Date.now(), cancelRequested: Boolean(row.cancel_requested), treeTermination: "unconfirmed" };
        this.#db.prepare("INSERT INTO receipts(process_id,payload) VALUES(?,?)").run(id, JSON.stringify(receipt));
        const state = detail.kind === "exit" ? "EXITED" : detail.kind === "spawn_failed" ? "FAILED" : "UNKNOWN";
        this.#db.prepare("UPDATE processes SET state=?,updated=? WHERE id=?").run(state, Date.now(), id);
      });
    } catch { this.#faulted = true; }
  }

  status(raw: unknown): ProcessView {
    const input = querySchema.parse(raw);
    return this.#view(this.#row(input.id, input.owner));
  }

  lookup(raw: unknown): ProcessView {
    const input = z.object({ dispatchKey: z.string().min(1).max(256), owner: ownerSchema }).strict().parse(raw);
    const identity = this.#checkOwner(input.owner);
    const row = this.#db.prepare("SELECT * FROM processes WHERE dispatch_key=?").get(input.dispatchKey) as Row | undefined;
    if (!row || row.owner !== identity) throw new ProcessHostError("PROCESS_NOT_FOUND");
    return this.#view(row);
  }

  output(raw: unknown): { id: string; stream: string; offset: number; nextOffset: number; dataBase64: string; truncated: boolean; availableBytes: number } {
    const input = outputSchema.parse(raw);
    const row = this.#row(input.id, input.owner);
    const available = Number(row[input.stream + "_bytes"]);
    if (input.offset > available) throw new ProcessHostError("OUTPUT_OFFSET_INVALID");
    const count = Math.min(input.limit, available - input.offset);
    const startPage = Math.floor(input.offset / PAGE_BYTES);
    const endPage = Math.floor((input.offset + Math.max(count - 1, 0)) / PAGE_BYTES);
    const rows = this.#db.prepare("SELECT bytes FROM output_pages WHERE process_id=? AND stream=? AND page>=? AND page<=? ORDER BY page").all(input.id, input.stream, startPage, endPage) as { bytes: Uint8Array }[];
    const bytes = Buffer.concat(rows.map((page) => Buffer.from(page.bytes))).subarray(input.offset % PAGE_BYTES, input.offset % PAGE_BYTES + count);
    return { id: input.id, stream: input.stream, offset: input.offset, nextOffset: input.offset + bytes.length, dataBase64: bytes.toString("base64"), truncated: Boolean(row.truncated), availableBytes: available };
  }

  cancel(raw: unknown): ProcessView {
    const input = querySchema.parse(raw);
    const row = this.#row(input.id, input.owner);
    if (["EXITED", "FAILED", "UNKNOWN"].includes(String(row.state))) return this.#view(row);
    this.#db.prepare("UPDATE processes SET cancel_requested=1,state='CANCEL_REQUESTED',updated=? WHERE id=?").run(Date.now(), input.id);
    if (this.#scheduled.delete(input.id)) {
      this.#finish(input.id, { kind: "spawn_failed", reason: "CANCELLED_BEFORE_SPAWN", directTermination: "confirmed" });
    } else {
      const owned = this.#children.get(input.id);
      // Never derive a kill target from the persisted pid: only a live owned handle.
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        try { owned.kill("SIGTERM"); } catch { /* termination remains unconfirmed */ }
      }
    }
    return this.#view(this.#row(input.id, input.owner));
  }

  health() {
    const bindingDigest = createHash("sha256").update(JSON.stringify([this.#options.slot, this.#options.principal, this.#options.workspaceRoot])).digest("hex");
    return { alive: !this.#closed, executorBootId: this.bootId, bindingDigest, mode: "trusted-host", filesystemIsolation: false, networkIsolation: false, processTreeTermination: "unconfirmed", storageFault: this.#faulted, activeProcesses: this.#children.size, pendingDispatches: this.#scheduled.size };
  }

  async handle(method: string, input: unknown, role: RpcRole): Promise<unknown> {
    try {
      if (role !== "client") throw new ProcessHostError("FORBIDDEN");
      if (this.#closed) throw new ProcessHostError("HOST_CLOSED");
      switch (method) {
        case "process_submit": return this.submit(input);
        case "process_status": return this.status(input);
        case "process_lookup": return this.lookup(input);
        case "process_output": return this.output(input);
        case "process_cancel": return this.cancel(input);
        case "process_health": return this.health();
        default: throw new ProcessHostError("METHOD_NOT_FOUND");
      }
    } catch (error) {
      return { error: { code: error instanceof ProcessHostError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "PROCESS_STORAGE_ERROR" } };
    }
  }

  close(): Promise<void> {
    return this.#closePromise ??= (async () => {
      this.#closing = true;
      for (const row of this.#db.prepare("SELECT * FROM processes WHERE state IN ('REGISTERED','RUNNING','CANCEL_REQUESTED')").all() as Row[]) {
        const view = this.#view(row);
        this.cancel({ id: view.id, owner: view.owner });
      }
      const deadline = Date.now() + 2000;
      while (this.#children.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      for (const [id, child] of this.#children) {
        this.#finish(id, { kind: "unknown", reason: "HOST_STOPPED_WITH_UNCONFIRMED_TERMINATION", directTermination: "unconfirmed" });
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      }
      this.#transaction(() => {
        this.#db.prepare("UPDATE host_identity SET pid=NULL,boot=NULL WHERE singleton=1 AND boot=?").run(this.bootId);
      });
      this.#closed = true;
      this.#db.close();
      this.#ownerLock.close();
    })();
  }
}
