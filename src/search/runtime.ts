import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertAccessiblePath } from "../security.js";
import type {
  SearchLimitReason,
  SearchMode,
  SearchPage,
  SearchResult,
  SearchSessionRecord,
  SearchStatusView
} from "./types.js";

const MAX_SESSIONS = 100;
const MAX_ACTIVE_SEARCHES = 8;
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULTS = 1000;
const HARD_MAX_RESULTS = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 120_000;
const PREVIEW_CHARS = 300;
const SKIP_DIRS = new Set([".git", ".p05", "node_modules", "dist"]);

type LiveSearch = {
  record: SearchSessionRecord;
  query: string;
  caseSensitive: boolean;
  root: string;
  workspaceRoot: string;
  maxResults: number;
  timeoutMs: number;
  results: SearchResult[];
  stopped: boolean;
};

type PersistedState = {
  version: 1;
  sessions: SearchSessionRecord[];
};

function now(): string {
  return new Date().toISOString();
}

function finished(state: SearchSessionRecord["state"]): boolean {
  return state !== "running";
}

function safeRecord(value: unknown): SearchSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SearchSessionRecord>;
  if (
    typeof item.id !== "string" ||
    typeof item.workspaceId !== "string" ||
    (item.mode !== "text" && item.mode !== "name") ||
    typeof item.state !== "string" ||
    typeof item.startedAt !== "string" ||
    typeof item.lastActivityAt !== "string" ||
    typeof item.resultCount !== "number" ||
    typeof item.scannedFiles !== "number" ||
    typeof item.limited !== "boolean"
  ) return undefined;

  const states = new Set(["running", "completed", "stopped", "failed", "interrupted"]);
  if (!states.has(item.state)) return undefined;

  return {
    id: item.id,
    workspaceId: item.workspaceId,
    mode: item.mode,
    state: item.state as SearchSessionRecord["state"],
    startedAt: item.startedAt,
    lastActivityAt: item.lastActivityAt,
    ...(typeof item.finishedAt === "string" ? { finishedAt: item.finishedAt } : {}),
    resultCount: item.resultCount,
    scannedFiles: item.scannedFiles,
    limited: item.limited,
    ...(item.limitReason === "max-results" || item.limitReason === "timeout"
      ? { limitReason: item.limitReason }
      : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {})
  };
}

export class SearchRuntime {
  readonly #statePath: string;
  readonly #workspace: () => { id: string; root: string };
  readonly #records = new Map<string, SearchSessionRecord>();
  readonly #live = new Map<string, LiveSearch>();

  constructor(
    statePath: string,
    workspace: () => { id: string; root: string }
  ) {
    this.#statePath = statePath;
    this.#workspace = workspace;
    this.#load();
  }

  #load(): void {
    if (!fs.existsSync(this.#statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#statePath, "utf8")) as Partial<PersistedState>;
      for (const raw of parsed.sessions ?? []) {
        const record = safeRecord(raw);
        if (!record) continue;
        if (record.state === "running") {
          const changed = now();
          record.state = "interrupted";
          record.finishedAt = changed;
          record.lastActivityAt = changed;
          record.error = "Search was interrupted by P05 restart.";
        }
        this.#records.set(record.id, record);
      }
      this.#trim();
      this.#persist();
    } catch {
      throw new Error("Search session state is invalid.");
    }
  }

  #trim(): void {
    if (this.#records.size <= MAX_SESSIONS) return;
    const removable = [...this.#records.values()]
      .filter((record) => finished(record.state))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    while (this.#records.size > MAX_SESSIONS && removable.length > 0) {
      const removed = removable.shift()!;
      this.#records.delete(removed.id);
      this.#live.delete(removed.id);
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const state: PersistedState = {
      version: 1,
      sessions: [...this.#records.values()]
    };
    const temp = this.#statePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.#statePath);
  }

  #assert(id: string): SearchSessionRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown search session "${id}".`);
    const workspace = this.#workspace();
    if (record.workspaceId !== workspace.id) {
      throw new Error(
        `Search session "${id}" belongs to workspace "${record.workspaceId}", ` +
        `not active workspace "${workspace.id}".`
      );
    }
    return record;
  }

  #touch(live: LiveSearch): void {
    live.record.lastActivityAt = now();
    live.record.resultCount = live.results.length;
    this.#records.set(live.record.id, { ...live.record });
    // Search results stay memory-only. Persist bounded progress periodically so a
    // restart can classify the session without turning every match into a disk write.
    if (live.results.length % 50 === 0) this.#persist();
  }

  #complete(
    live: LiveSearch,
    state: "completed" | "stopped" | "failed",
    error?: string
  ): void {
    const changed = now();
    live.record.state = state;
    live.record.finishedAt = changed;
    live.record.lastActivityAt = changed;
    live.record.resultCount = live.results.length;
    if (error) live.record.error = error;
    this.#records.set(live.record.id, { ...live.record });
    this.#persist();
  }

  async start(args: {
    mode: SearchMode;
    query: string;
    path?: string;
    caseSensitive?: boolean;
    maxResults?: number;
    timeoutMs?: number;
  }): Promise<SearchStatusView> {
    const workspace = this.#workspace();
    const activeCount = [...this.#records.values()]
      .filter((record) => record.state === "running")
      .length;
    if (activeCount >= MAX_ACTIVE_SEARCHES) {
      throw new Error(`Too many active searches (limit ${MAX_ACTIVE_SEARCHES}).`);
    }

    const query = args.query;
    if (!query) throw new Error("Search query must not be empty.");

    const root = await assertAccessiblePath(
      args.path ?? workspace.root,
      "read",
      workspace.root,
      workspace.root
    );

    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error("Search path must be a directory.");

    const maxResults = Math.min(
      Math.max(args.maxResults ?? DEFAULT_MAX_RESULTS, 1),
      HARD_MAX_RESULTS
    );
    const timeoutMs = Math.min(
      Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000),
      HARD_TIMEOUT_MS
    );

    const id = `search-${randomUUID()}`;
    const startedAt = now();
    const record: SearchSessionRecord = {
      id,
      workspaceId: workspace.id,
      mode: args.mode,
      state: "running",
      startedAt,
      lastActivityAt: startedAt,
      resultCount: 0,
      scannedFiles: 0,
      limited: false
    };

    const live: LiveSearch = {
      record,
      query,
      caseSensitive: args.caseSensitive ?? false,
      root,
      workspaceRoot: workspace.root,
      maxResults,
      timeoutMs,
      results: [],
      stopped: false
    };

    this.#records.set(id, { ...record });
    this.#live.set(id, live);
    this.#trim();
    this.#persist();
    void this.#run(live);
    return { ...record };
  }

  async #run(live: LiveSearch): Promise<void> {
    const deadline = Date.now() + live.timeoutMs;

    try {
      const stack = [live.root];
      while (stack.length > 0 && !live.stopped) {
        if (Date.now() >= deadline) {
          live.record.limited = true;
          live.record.limitReason = "timeout";
          break;
        }
        if (live.results.length >= live.maxResults) {
          live.record.limited = true;
          live.record.limitReason = "max-results";
          break;
        }

        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (live.stopped) break;
          if (Date.now() >= deadline) {
            live.record.limited = true;
            live.record.limitReason = "timeout";
            break;
          }
          if (live.results.length >= live.maxResults) {
            live.record.limited = true;
            live.record.limitReason = "max-results";
            break;
          }
          if (entry.isSymbolicLink()) continue;

          const full = path.join(dir, entry.name);
          const relative = path.relative(live.workspaceRoot, full).replaceAll("\\", "/");

          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;

          live.record.scannedFiles += 1;

          if (live.record.mode === "name") {
            const haystack = live.caseSensitive ? relative : relative.toLowerCase();
            const needle = live.caseSensitive ? live.query : live.query.toLowerCase();
            if (haystack.includes(needle)) {
              live.results.push({
                index: live.results.length,
                path: relative
              });
              this.#touch(live);
            }
            continue;
          }

          try {
            await assertAccessiblePath(
              full,
              "read",
              live.workspaceRoot,
              live.workspaceRoot
            );
          } catch {
            // Protected paths (for example .env/credentials) are intentionally skipped.
            continue;
          }

          let stat: fs.Stats;
          try {
            stat = await fsp.stat(full);
          } catch {
            continue;
          }
          if (stat.size > MAX_FILE_BYTES) continue;

          let content: string;
          try {
            const buffer = await fsp.readFile(full);
            if (buffer.includes(0)) continue;
            content = buffer.toString("utf8");
          } catch {
            continue;
          }

          const needle = live.caseSensitive ? live.query : live.query.toLowerCase();
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]!;
            const haystack = live.caseSensitive ? line : line.toLowerCase();
            const column = haystack.indexOf(needle);
            if (column < 0) continue;

            live.results.push({
              index: live.results.length,
              path: relative,
              line: i + 1,
              column: column + 1,
              preview: line.length > PREVIEW_CHARS
                ? line.slice(0, PREVIEW_CHARS) + "…"
                : line
            });
            this.#touch(live);

            if (live.results.length >= live.maxResults) {
              live.record.limited = true;
              live.record.limitReason = "max-results";
              break;
            }
          }
        }
      }

      if (live.record.state === "interrupted") {
        this.#records.set(live.record.id, { ...live.record });
        this.#persist();
      } else if (live.stopped) {
        this.#complete(live, "stopped");
      } else {
        this.#complete(live, "completed");
      }
    } catch (error) {
      this.#complete(
        live,
        "failed",
        error instanceof Error ? error.message : "Search failed."
      );
    }
  }

  status(id: string): SearchStatusView {
    return { ...this.#assert(id) };
  }

  list(): SearchStatusView[] {
    const workspace = this.#workspace();
    return [...this.#records.values()]
      .filter((record) => record.workspaceId === workspace.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => ({ ...record }));
  }

  page(id: string, cursor = 0, limit = 50): SearchPage {
    const record = this.#assert(id);
    const live = this.#live.get(id);
    const results = live?.results ?? [];
    const boundedLimit = Math.min(Math.max(limit, 1), 200);
    const page = results.slice(cursor, cursor + boundedLimit).map((result) => ({ ...result }));
    const nextCursor = cursor + page.length;
    const isFinished = finished(record.state);

    return {
      searchId: id,
      workspaceId: record.workspaceId,
      state: record.state,
      results: page,
      nextCursor,
      done: isFinished && nextCursor >= results.length,
      totalAvailable: results.length,
      limited: record.limited,
      ...(record.limitReason ? { limitReason: record.limitReason } : {})
    };
  }

  stop(id: string): SearchStatusView {
    const record = this.#assert(id);
    const live = this.#live.get(id);
    if (record.state === "running" && live) {
      live.stopped = true;
      record.lastActivityAt = now();
      this.#records.set(id, { ...record });
      this.#persist();
    }
    return { ...record };
  }

  interruptAll(): void {
    for (const live of this.#live.values()) {
      if (live.record.state !== "running") continue;
      live.stopped = true;
      const changed = now();
      live.record.state = "interrupted";
      live.record.finishedAt = changed;
      live.record.lastActivityAt = changed;
      live.record.error = "Search was interrupted by P05 shutdown.";
      this.#records.set(live.record.id, { ...live.record });
    }
    this.#persist();
  }
}
