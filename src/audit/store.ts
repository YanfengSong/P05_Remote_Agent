import fs from "node:fs";
import path from "node:path";
import type { AuditEvent } from "./types.js";

type PersistedAudit = {
  version: 1;
  events: AuditEvent[];
};

export class AuditStore {
  readonly #limit: number;
  readonly #events: AuditEvent[] = [];
  readonly #persistencePath?: string;

  constructor(limit = 200, persistencePath?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("AuditStore limit must be an integer between 1 and 5000.");
    }
    this.#limit = limit;
    this.#persistencePath = persistencePath;
    this.#load();
  }

  #load(): void {
    if (!this.#persistencePath || !fs.existsSync(this.#persistencePath)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.#persistencePath, "utf8")) as Partial<PersistedAudit>;
      if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
        throw new Error("unsupported audit state format");
      }

      const now = new Date().toISOString();
      for (const event of parsed.events.slice(-this.#limit)) {
        if (!event || typeof event !== "object" || typeof event.id !== "string") continue;
        if (event.state === "running") {
          this.#events.push({
            ...event,
            state: "failed",
            finishedAt: now,
            errorCategory: "interrupted",
            recoveryHint: "inspect"
          });
        } else {
          this.#events.push({ ...event });
        }
      }
      this.#persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid P05 audit state: ${message}`);
    }
  }

  #persist(): void {
    if (!this.#persistencePath) return;
    fs.mkdirSync(path.dirname(this.#persistencePath), { recursive: true });
    const payload: PersistedAudit = { version: 1, events: this.#events.slice(-this.#limit) };
    const temp = `${this.#persistencePath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.#persistencePath);
  }

  upsert(event: AuditEvent): void {
    const index = this.#events.findIndex((existing) => existing.id === event.id);
    if (index >= 0) {
      this.#events[index] = { ...event };
    } else {
      this.#events.push({ ...event });
      if (this.#events.length > this.#limit) {
        this.#events.splice(0, this.#events.length - this.#limit);
      }
    }
    this.#persist();
  }

  recent(limit = 20): AuditEvent[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.#events.slice(-bounded).reverse().map((event) => ({ ...event }));
  }

  recovery(limit = 20): AuditEvent[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.#events
      .filter((event) => event.state === "failed" && event.recoveryHint !== "none")
      .slice(-bounded)
      .reverse()
      .map((event) => ({ ...event }));
  }
}
