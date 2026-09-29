import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CoreIdentity {
  hostId: string;
  slotId: string;
  coreInstanceId: string;
  instanceGeneration: number;
}

interface OwnerRecord extends CoreIdentity {
  state: "active" | "released";
  startedAt: string;
  releasedAt?: string;
}

export interface CoreStateOptions {
  /** Operator-controlled local directory, outside every agent-writable workspace. */
  stateDir: string;
  slotId: string;
  workspaceRoots: string[];
  /** Authenticated maintenance acknowledgement, NOT a timeout or a PID check. */
  recoverUncleanOwner?: { coreInstanceId: string; reason: string };
}

export class CoreStateError extends Error {
  constructor(readonly code: string, message: string, readonly previousOwnerId?: string) {
    super(message);
    this.name = "CoreStateError";
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors too, so a symlink parent cannot bypass workspace exclusion. */
function canonicalFuturePath(input: string): string {
  const tail: string[] = [];
  let parent = path.resolve(input);
  while (!existsSync(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new CoreStateError("INVALID_STATE_DIRECTORY", "No existing ancestor");
    parent = next;
  }
  return path.join(realpathSync(parent), ...tail);
}

function rejectLink(file: string): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new CoreStateError("UNTRUSTED_STATE_PATH", "State file cannot be a symbolic link");
}

function openDatabase(file: string, busyTimeoutMs = 5_000): DatabaseSync {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rejectLink(file + suffix);
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=FULL;`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export class CoreState {
  readonly identity: Readonly<CoreIdentity>;
  readonly stateDir: string;
  readonly slotDir: string;
  private closed = false;

  private constructor(private readonly database: DatabaseSync, private readonly ownerLock: DatabaseSync,
    stateDir: string, slotDir: string, identity: CoreIdentity) {
    this.stateDir = stateDir;
    this.slotDir = slotDir;
    this.identity = Object.freeze(identity);
  }

  static open(options: CoreStateOptions): CoreState {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(options.slotId)) throw new CoreStateError("INVALID_SLOT_ID", "Slot ID must be a bounded path-safe identifier");
    if (!path.isAbsolute(options.stateDir) || /^[/\\]{2}/.test(options.stateDir)) throw new CoreStateError("INVALID_STATE_DIRECTORY", "State must use an absolute local path, not a network path");
    const stateDir = canonicalFuturePath(options.stateDir);
    for (const workspace of options.workspaceRoots) {
      if (!path.isAbsolute(workspace)) throw new CoreStateError("INVALID_WORKSPACE_ROOT", "Workspace root must be absolute");
      const root = canonicalFuturePath(workspace);
      if (within(root, stateDir) || within(stateDir, root)) throw new CoreStateError("STATE_WORKSPACE_OVERLAP", "Protected state and workspaces must be disjoint");
    }
    if (path.parse(stateDir).root === stateDir) throw new CoreStateError("INVALID_STATE_DIRECTORY", "State directory cannot be a filesystem root");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (lstatSync(stateDir).mode & 0o077) !== 0) throw new CoreStateError("UNPROTECTED_STATE_DIRECTORY", "State directory must be private to its OS owner");
    const slotsDir = path.join(stateDir, "slots");
    rejectLink(slotsDir);
    const slotDir = path.join(slotsDir, options.slotId.toLowerCase());
    rejectLink(slotDir);
    mkdirSync(slotDir, { recursive: true, mode: 0o700 });

    let ownerLock: DatabaseSync | undefined;
    let database: DatabaseSync | undefined;
    try {
      // A dedicated DELETE-journal DB holds an OS-backed exclusive SQLite lock for
      // the whole owner lifetime. Never unlink it, use WAL, or decide ownership by PID/TTL.
      try {
        ownerLock = openDatabase(path.join(slotDir, "owner-lock.sqlite"), 0);
        ownerLock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      } catch (error) {
        if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw new CoreStateError("SLOT_ALREADY_OWNED", "Cannot establish exclusive Slot ownership");
        throw error;
      }

      const host = openDatabase(path.join(stateDir, "host.sqlite"));
      let hostId: string;
      try {
        host.exec("CREATE TABLE IF NOT EXISTS host_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host_id TEXT NOT NULL); BEGIN IMMEDIATE;");
        host.prepare("INSERT OR IGNORE INTO host_identity VALUES (1, ?)").run(randomUUID());
        hostId = (host.prepare("SELECT host_id FROM host_identity WHERE singleton=1").get() as { host_id: string }).host_id;
        host.exec("COMMIT;");
      } finally { host.close(); }
      if (typeof hostId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)) throw new CoreStateError("CORRUPT_HOST_IDENTITY", "Stored Host identity is invalid");

      database = openDatabase(path.join(slotDir, "core.sqlite"));
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS core_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS core_state_versions (key TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT OR IGNORE INTO core_state_versions SELECT key, 1 FROM core_state WHERE key LIKE 'service:%' OR key LIKE 'supervision:%';");
      const row = database.prepare("SELECT value FROM core_state WHERE key='owner'").get() as { value: string } | undefined;
      const previous: OwnerRecord | undefined = row ? JSON.parse(row.value) : undefined;
      if (row && (!previous || typeof previous.coreInstanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(previous.coreInstanceId) || previous.hostId !== hostId || previous.slotId !== options.slotId || !Number.isSafeInteger(previous.instanceGeneration) || previous.instanceGeneration < 1 || !["active", "released"].includes(previous.state))) {
        throw new CoreStateError("CORRUPT_OWNER_RECORD", "Stored owner identity is inconsistent");
      }
      if (options.recoverUncleanOwner) {
        if (previous?.state !== "active") throw new CoreStateError("RECOVERY_NOT_REQUIRED", "Prior owner is no longer active; recovery acknowledgement is stale");
        if (options.recoverUncleanOwner.coreInstanceId !== previous.coreInstanceId || !options.recoverUncleanOwner.reason.trim()) throw new CoreStateError("RECOVERY_OWNER_MISMATCH", "Prior owner must match the explicitly inspected owner and include a reason", previous.coreInstanceId);
      } else if (previous?.state === "active") {
        throw new CoreStateError("UNCLEAN_OWNER_REQUIRES_MAINTENANCE", "Prior owner did not close cleanly; inspect executor state before acknowledging recovery", previous.coreInstanceId);
      }
      const identity: CoreIdentity = { hostId, slotId: options.slotId, coreInstanceId: randomUUID(), instanceGeneration: (previous?.instanceGeneration ?? 0) + 1 };
      if (!Number.isSafeInteger(identity.instanceGeneration)) throw new CoreStateError("GENERATION_EXHAUSTED", "Generation exhausted");
      database.exec("BEGIN IMMEDIATE;");
      const write = database.prepare("INSERT INTO core_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      write.run("owner", JSON.stringify({ ...identity, state: "active", startedAt: new Date().toISOString() } satisfies OwnerRecord));
      if (previous?.state === "active") write.run(`recovery:${identity.instanceGeneration}`, JSON.stringify({ previousOwnerId: previous.coreInstanceId, reason: options.recoverUncleanOwner!.reason, at: new Date().toISOString() }));
      database.exec("COMMIT;");
      return new CoreState(database, ownerLock, stateDir, slotDir, identity);
    } catch (error) {
      try { database?.close(); } finally { ownerLock?.close(); }
      throw error;
    }
  }

  get<T>(key: string): T | undefined {
    if (this.closed) throw new CoreStateError("CORE_CLOSED", "Core state is closed");
    const row = this.database.prepare("SELECT value FROM core_state WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  /** Internal trusted storage only. Never expose arbitrary keys over MCP. */
  put(key: string, value: unknown): void {
    this.writeVersioned(key, value);
  }

  private mutableKey(key: string): void {
    if (this.closed) throw new CoreStateError("CORE_CLOSED", "Core state is closed");
    if (!/^(service:|supervision:)/.test(key)) throw new CoreStateError("RESERVED_STATE_KEY", "Key is not in a mutable Core namespace");
  }

  readVersioned<T>(key: string): { version: number; value: T } | undefined {
    this.mutableKey(key);
    const row = this.database.prepare("SELECT s.value, v.version FROM core_state s JOIN core_state_versions v ON s.key=v.key WHERE s.key=?").get(key) as { value: string; version: number } | undefined;
    return row ? { version: row.version, value: JSON.parse(row.value) as T } : undefined;
  }

  /** Bounded lexical-key pagination over one trusted mutable namespace. */
  listVersioned<T>(prefix: string, afterKey?: string, limit = 25): { key: string; version: number; value: T }[] {
    this.mutableKey(prefix);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreStateError("INVALID_STATE_PAGE_LIMIT", "Page limit must be between 1 and 100");
    if (afterKey !== undefined && !afterKey.startsWith(prefix)) throw new CoreStateError("INVALID_STATE_CURSOR", "Cursor must belong to the selected prefix");
    const rows = this.database.prepare("SELECT s.key, s.value, v.version FROM core_state s JOIN core_state_versions v ON s.key=v.key WHERE substr(s.key,1,length(?))=? AND s.key>? ORDER BY s.key LIMIT ?").all(prefix, prefix, afterKey ?? "", limit) as { key: string; value: string; version: number }[];
    return rows.map((row) => ({ key: row.key, version: row.version, value: JSON.parse(row.value) as T }));
  }

  compareAndSet(key: string, expectedVersion: number | null, value: unknown): boolean {
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new CoreStateError("INVALID_STATE_VERSION", "Expected version must be positive or null");
    return this.writeVersioned(key, value, expectedVersion);
  }

  private writeVersioned(key: string, value: unknown, expectedVersion?: number | null): boolean {
    this.mutableKey(key);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new CoreStateError("INVALID_STATE_VALUE", "State value must be JSON serializable");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.readVersioned(key);
      if (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion) { this.database.exec("COMMIT;"); return false; }
      const version = (current?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version)) throw new CoreStateError("STATE_VERSION_EXHAUSTED", "State version exhausted");
      this.database.prepare("INSERT INTO core_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, encoded);
      this.database.prepare("INSERT INTO core_state_versions VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET version=excluded.version").run(key, version);
      this.database.exec("COMMIT;"); return true;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  probe(): boolean {
    if (this.closed) return false;
    try { return (this.database.prepare("PRAGMA quick_check(1)").get() as { quick_check: string }).quick_check === "ok"; }
    catch { return false; }
  }

  close(): void {
    if (this.closed) return;
    try {
      const owner = this.get<OwnerRecord>("owner")!;
      this.database.prepare("UPDATE core_state SET value=? WHERE key='owner'").run(JSON.stringify({ ...owner, state: "released", releasedAt: new Date().toISOString() }));
    } finally {
      this.closed = true;
      try { this.database.close(); } finally { this.ownerLock.close(); }
    }
  }
}
