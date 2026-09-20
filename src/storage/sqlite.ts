import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionContext } from "../runtime/context.js";
import type {
  IsolationStateRecord,
  RunEvent,
  RunFilter,
  RunRecord,
  RunState
} from "../run/types.js";
import type { StateStore } from "./types.js";

type Row = Record<string, string | number | null>;

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Invalid JSON column.");
  return JSON.parse(value) as T;
}

function runFromRow(row: Row): RunRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    ...(row.parent_run_id ? { parentRunId: String(row.parent_run_id) } : {}),
    context: parseJson<ExecutionContext>(row.context_json),
    state: String(row.state) as RunState,
    ownerType: String(row.owner_type),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    recoveryHint: String(row.recovery_hint) as RunRecord["recoveryHint"],
    sequence: Number(row.sequence),
    domain: parseJson<RunRecord["domain"]>(row.domain_json)
  };
}

function eventFromRow(row: Row): RunEvent {
  return {
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    type: String(row.type),
    at: String(row.at),
    payload: parseJson<RunEvent["payload"]>(row.payload_json)
  };
}

function isolationFromRow(row: Row): IsolationStateRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerActorType: String(row.owner_actor_type),
    ownerActorId: String(row.owner_actor_id),
    mode: String(row.mode),
    state: String(row.state),
    ...(row.base_commit ? { baseCommit: String(row.base_commit) } : {}),
    ...(row.reconciled_commit ? { reconciledCommit: String(row.reconciled_commit) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.released_at ? { releasedAt: String(row.released_at) } : {})
  };
}

export class SqliteStateStore implements StateStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA synchronous=NORMAL;");
    this.#db.exec("PRAGMA foreign_keys=ON;");
    this.#db.exec("PRAGMA busy_timeout=5000;");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        parent_run_id TEXT,
        context_json TEXT NOT NULL,
        state TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        recovery_hint TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        domain_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_kind_state
        ON runs(kind, state);
      CREATE INDEX IF NOT EXISTS idx_runs_workspace
        ON runs(json_extract(context_json, '$.workspaceId'));

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS isolation_allocations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_actor_type TEXT NOT NULL,
        owner_actor_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        base_commit TEXT,
        reconciled_commit TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT
      );

      INSERT OR IGNORE INTO schema_meta(key, value)
        VALUES ('schema_version', '1');
    `);
  }

  #transaction(operation: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      operation();
      this.#db.exec("COMMIT;");
    } catch (error) {
      this.#db.exec("ROLLBACK;");
      throw error;
    }
  }

  #insertEvent(event: RunEvent): void {
    this.#db.prepare(`
      INSERT INTO run_events(run_id, sequence, type, at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.runId,
      event.sequence,
      event.type,
      event.at,
      JSON.stringify(event.payload)
    );
  }

  createRun(run: RunRecord, event: RunEvent): void {
    this.#transaction(() => {
      this.#db.prepare(`
        INSERT INTO runs(
          id, kind, parent_run_id, context_json, state, owner_type,
          created_at, updated_at, started_at, finished_at,
          recovery_hint, sequence, domain_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.kind,
        run.parentRunId ?? null,
        JSON.stringify(run.context),
        run.state,
        run.ownerType,
        run.createdAt,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.recoveryHint,
        run.sequence,
        JSON.stringify(run.domain)
      );
      this.#insertEvent(event);
    });
  }

  updateRunAndAppendEvent(run: RunRecord, event: RunEvent): void {
    this.#transaction(() => {
      const result = this.#db.prepare(`
        UPDATE runs SET
          state = ?,
          updated_at = ?,
          started_at = ?,
          finished_at = ?,
          recovery_hint = ?,
          sequence = ?,
          domain_json = ?
        WHERE id = ? AND sequence = ?
      `).run(
        run.state,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.recoveryHint,
        run.sequence,
        JSON.stringify(run.domain),
        run.id,
        run.sequence - 1
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Run transition conflict for " + run.id + ".");
      }
      this.#insertEvent(event);
    });
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  listRuns(filter: RunFilter = {}): RunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind); }
    if (filter.state) { clauses.push("state = ?"); params.push(filter.state); }
    if (filter.workspaceId) {
      clauses.push("json_extract(context_json, '$.workspaceId') = ?");
      params.push(filter.workspaceId);
    }
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000);
    const sql = "SELECT * FROM runs" +
      (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
      " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.#db.prepare(sql).all(...params) as Row[];
    return rows.map(runFromRow);
  }

  listRunEvents(runId: string, afterSequence = 0, limit = 200): RunEvent[] {
    const bounded = Math.min(Math.max(limit, 1), 2000);
    const rows = this.#db.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(runId, afterSequence, bounded) as Row[];
    return rows.map(eventFromRow);
  }

  upsertIsolation(record: IsolationStateRecord): void {
    this.#db.prepare(`
      INSERT INTO isolation_allocations(
        id, workspace_id, owner_actor_type, owner_actor_id, mode, state,
        base_commit, reconciled_commit, created_at, updated_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        base_commit = excluded.base_commit,
        reconciled_commit = excluded.reconciled_commit,
        updated_at = excluded.updated_at,
        released_at = excluded.released_at
    `).run(
      record.id,
      record.workspaceId,
      record.ownerActorType,
      record.ownerActorId,
      record.mode,
      record.state,
      record.baseCommit ?? null,
      record.reconciledCommit ?? null,
      record.createdAt,
      record.updatedAt,
      record.releasedAt ?? null
    );
  }

  getIsolation(id: string): IsolationStateRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM isolation_allocations WHERE id = ?"
    ).get(id) as Row | undefined;
    return row ? isolationFromRow(row) : undefined;
  }

  listIsolations(workspaceId?: string): IsolationStateRecord[] {
    const rows = workspaceId
      ? this.#db.prepare(
          "SELECT * FROM isolation_allocations WHERE workspace_id = ? ORDER BY created_at DESC"
        ).all(workspaceId) as Row[]
      : this.#db.prepare(
          "SELECT * FROM isolation_allocations ORDER BY created_at DESC"
        ).all() as Row[];
    return rows.map(isolationFromRow);
  }

  close(): void {
    this.#db.close();
  }
}
