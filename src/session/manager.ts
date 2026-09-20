import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../runtime/context.js";
import type {
  SessionAttribute,
  SessionEvent,
  SessionEventPage,
  SessionRecord,
  SessionRecoveryHint,
  SessionState
} from "./types.js";

const MAX_SESSIONS = 200;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 64 * 1024;

type PersistedState = {
  version: 1;
  sessions: SessionRecord[];
};

type EventBuffer = {
  events: SessionEvent[];
  bytes: number;
  nextSeq: number;
};

function now(): string {
  return new Date().toISOString();
}

function terminal(state: SessionState): boolean {
  return ["completed", "failed", "interrupted"].includes(state);
}

function safeAttribute(value: unknown): SessionAttribute | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : undefined;
}

function safeRecord(value: unknown): SessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SessionRecord>;
  if (
    typeof item.id !== "string" ||
    typeof item.kind !== "string" ||
    typeof item.driverId !== "string" ||
    !item.context ||
    typeof item.context !== "object" ||
    typeof item.state !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.lastActivityAt !== "string" ||
    !item.attributes ||
    typeof item.attributes !== "object"
  ) return undefined;

  const states = new Set<SessionState>([
    "created", "starting", "running", "stopping", "completed", "failed", "interrupted"
  ]);
  if (!states.has(item.state as SessionState)) return undefined;

  const context = item.context as ExecutionContext;
  if (
    typeof context.executionId !== "string" ||
    typeof context.workspaceId !== "string" ||
    typeof context.workspaceRoot !== "string" ||
    !context.actor ||
    typeof context.actor.id !== "string" ||
    typeof context.actor.type !== "string" ||
    !context.authority ||
    typeof context.authority.profile !== "string" ||
    typeof context.capturedAt !== "string"
  ) return undefined;

  const attributes: Record<string, SessionAttribute> = {};
  for (const [key, raw] of Object.entries(item.attributes)) {
    const safe = safeAttribute(raw);
    if (safe !== undefined) attributes[key] = safe;
  }

  return {
    id: item.id,
    kind: item.kind,
    driverId: item.driverId,
    context,
    state: item.state as SessionState,
    createdAt: item.createdAt,
    ...(typeof item.startedAt === "string" ? { startedAt: item.startedAt } : {}),
    lastActivityAt: item.lastActivityAt,
    ...(typeof item.finishedAt === "string" ? { finishedAt: item.finishedAt } : {}),
    recoveryHint:
      item.recoveryHint === "none" ||
      item.recoveryHint === "retry" ||
      item.recoveryHint === "inspect"
        ? item.recoveryHint
        : "inspect",
    attributes
  };
}

export class SessionManager {
  readonly #statePath: string;
  readonly #records = new Map<string, SessionRecord>();
  readonly #events = new Map<string, EventBuffer>();

  constructor(statePath: string) {
    this.#statePath = statePath;
    this.#load();
  }

  #load(): void {
    if (!fs.existsSync(this.#statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#statePath, "utf8")) as Partial<PersistedState>;
      for (const raw of parsed.sessions ?? []) {
        const record = safeRecord(raw);
        if (!record) continue;

        if (!terminal(record.state)) {
          const changed = now();
          record.state = "interrupted";
          record.finishedAt = changed;
          record.lastActivityAt = changed;
          record.recoveryHint = "inspect";
        }
        this.#records.set(record.id, record);
      }
      this.#trim();
      this.#persist();
    } catch {
      throw new Error("Session state is invalid.");
    }
  }

  #trim(): void {
    if (this.#records.size <= MAX_SESSIONS) return;
    const removable = [...this.#records.values()]
      .filter((record) => terminal(record.state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.#records.size > MAX_SESSIONS && removable.length > 0) {
      const removed = removable.shift()!;
      this.#records.delete(removed.id);
      this.#events.delete(removed.id);
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const temp = this.#statePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({
      version: 1,
      sessions: [...this.#records.values()]
    }, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.#statePath);
  }

  create(args: {
    kind: string;
    driverId: string;
    context: ExecutionContext;
    attributes?: Record<string, SessionAttribute>;
  }): SessionRecord {
    const id = `session-${randomUUID()}`;
    const createdAt = now();
    const record: SessionRecord = {
      id,
      kind: args.kind,
      driverId: args.driverId,
      context: {
        ...args.context,
        sessionId: id,
        actor: { ...args.context.actor },
        authority: { ...args.context.authority },
        ...(args.context.isolation
          ? { isolation: { ...args.context.isolation } }
          : {})
      },
      state: "created",
      createdAt,
      lastActivityAt: createdAt,
      recoveryHint: "inspect",
      attributes: { ...(args.attributes ?? {}) }
    };
    this.#records.set(id, record);
    this.#events.set(id, { events: [], bytes: 0, nextSeq: 1 });
    this.#trim();
    this.#persist();
    return this.get(id);
  }

  get(id: string): SessionRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown session "${id}".`);
    return {
      ...record,
      context: {
        ...record.context,
        actor: { ...record.context.actor },
        authority: { ...record.context.authority },
        ...(record.context.isolation
          ? { isolation: { ...record.context.isolation } }
          : {})
      },
      attributes: { ...record.attributes }
    };
  }

  list(args?: { workspaceId?: string; kind?: string }): SessionRecord[] {
    return [...this.#records.values()]
      .filter((record) =>
        (!args?.workspaceId || record.context.workspaceId === args.workspaceId) &&
        (!args?.kind || record.kind === args.kind)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => this.get(record.id));
  }

  transition(
    id: string,
    state: SessionState,
    args?: {
      recoveryHint?: SessionRecoveryHint;
      attributes?: Record<string, SessionAttribute>;
    }
  ): SessionRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown session "${id}".`);

    const changed = now();
    record.state = state;
    record.lastActivityAt = changed;
    if (state === "running" && !record.startedAt) record.startedAt = changed;
    if (terminal(state)) record.finishedAt = changed;
    if (args?.recoveryHint) record.recoveryHint = args.recoveryHint;
    if (args?.attributes) Object.assign(record.attributes, args.attributes);

    this.#records.set(id, record);
    this.#persist();
    return this.get(id);
  }

  touch(
    id: string,
    attributes?: Record<string, SessionAttribute>
  ): SessionRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown session "${id}".`);
    record.lastActivityAt = now();
    if (attributes) Object.assign(record.attributes, attributes);
    this.#records.set(id, record);
    this.#persist();
    return this.get(id);
  }

  appendEvent(id: string, channel: string, text: string): SessionEvent | undefined {
    if (!text) return undefined;
    if (!this.#records.has(id)) throw new Error(`Unknown session "${id}".`);

    const buffer = this.#events.get(id) ?? { events: [], bytes: 0, nextSeq: 1 };
    const event: SessionEvent = {
      seq: buffer.nextSeq++,
      channel,
      text,
      timestamp: now()
    };
    buffer.events.push(event);
    buffer.bytes += Buffer.byteLength(text, "utf8");

    while (buffer.bytes > MAX_EVENT_BYTES && buffer.events.length > 1) {
      const removed = buffer.events.shift()!;
      buffer.bytes -= Buffer.byteLength(removed.text, "utf8");
    }

    this.#events.set(id, buffer);
    const record = this.#records.get(id)!;
    record.lastActivityAt = event.timestamp;
    this.#records.set(id, record);
    return { ...event };
  }

  events(
    id: string,
    cursor = 0,
    maxChars = MAX_EVENT_CHARS
  ): SessionEventPage {
    if (!this.#records.has(id)) throw new Error(`Unknown session "${id}".`);
    const buffer = this.#events.get(id) ?? { events: [], bytes: 0, nextSeq: 1 };
    const firstSeq = buffer.events[0]?.seq ?? (cursor + 1);
    const truncated = cursor > 0 && firstSeq > cursor + 1;

    let chars = 0;
    const selected: SessionEvent[] = [];
    for (const event of buffer.events) {
      if (event.seq <= cursor) continue;
      if (chars + event.text.length > maxChars && selected.length > 0) break;

      const remaining = Math.max(0, maxChars - chars);
      if (remaining === 0) break;
      const text = event.text.length > remaining
        ? event.text.slice(0, remaining)
        : event.text;
      selected.push({ ...event, text });
      chars += text.length;
      if (text.length < event.text.length) break;
    }

    return {
      sessionId: id,
      events: selected,
      nextCursor: selected.at(-1)?.seq ?? cursor,
      truncated
    };
  }

  bufferedEventCount(id: string): number {
    return this.#events.get(id)?.events.length ?? 0;
  }

  interruptNonTerminal(): void {
    for (const record of this.#records.values()) {
      if (terminal(record.state)) continue;
      const changed = now();
      record.state = "interrupted";
      record.finishedAt = changed;
      record.lastActivityAt = changed;
      record.recoveryHint = "inspect";
      this.#records.set(record.id, record);
    }
    this.#persist();
  }
}
