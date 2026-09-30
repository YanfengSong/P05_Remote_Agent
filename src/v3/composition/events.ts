import { z } from "zod";
import { CompositionError } from "./contracts.js";

export function immutableSnapshot<T>(input: T): Readonly<T> {
  const snapshot = structuredClone(input);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    // Event contracts use JSON values; mutable built-ins are deliberately excluded.
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new CompositionError("NON_JSON_SNAPSHOT");
    seen.add(value);
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

const interceptorResult = z.object({
  deny: z.boolean().optional(),
  metadata: z.record(z.string().max(64), z.string().max(1024)).optional(),
}).strict();
export interface InterceptorEnvelope {
  actorId: string;
  authorityDigest: string;
  approvalDigest: string;
  payload: unknown;
}
export interface InterceptorResult { deny?: boolean; metadata?: Record<string, string> }
type Observe = { callback: (event: Readonly<unknown>) => void | Promise<void>; failed: () => void; busy: boolean };

/** In-memory observations only; durable domain events belong to Run outbox. */
export class CompositionEvents {
  private readonly observers = new Map<string, Set<Observe>>();
  private readonly interceptors = new Map<string, { id: number; priority: number; callback: (input: Readonly<InterceptorEnvelope>) => Promise<InterceptorResult> | InterceptorResult }[]>();
  private sequence = 0;

  constructor(private readonly extensionPoints: ReadonlySet<string> = new Set(), private readonly timeoutMs = 1_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new CompositionError("INVALID_HOOK_TIMEOUT");
  }

  subscribe(topic: string, callback: Observe["callback"], failed: () => void): () => void {
    const set = this.observers.get(topic) ?? new Set<Observe>();
    if (set.size >= 64) throw new CompositionError("OBSERVER_QUOTA");
    const observer: Observe = { callback, failed, busy: false };
    set.add(observer); this.observers.set(topic, set);
    return () => { set.delete(observer); if (!set.size) this.observers.delete(topic); };
  }

  async emit(topic: string, value: unknown): Promise<void> {
    const snapshot = immutableSnapshot(value);
    await Promise.all([...this.observers.get(topic) ?? []].map(async (observer) => {
      if (observer.busy) return; // Drop observations under pressure; never queue unbounded work.
      observer.busy = true;
      try { await this.bounded(() => observer.callback(snapshot)); }
      catch { this.observers.get(topic)?.delete(observer); try { observer.failed(); } catch { /* observer failure cannot escape into publisher */ } }
      finally { observer.busy = false; }
    }));
  }

  intercept(point: string, priority: number, callback: (input: Readonly<InterceptorEnvelope>) => Promise<InterceptorResult> | InterceptorResult): () => void {
    if (!this.extensionPoints.has(point) || !Number.isSafeInteger(priority)) throw new CompositionError("UNKNOWN_EXTENSION_POINT");
    const list = this.interceptors.get(point) ?? [];
    if (list.length >= 32) throw new CompositionError("INTERCEPTOR_QUOTA");
    const entry = { id: ++this.sequence, priority, callback };
    list.push(entry); list.sort((a, b) => a.priority - b.priority || a.id - b.id);
    this.interceptors.set(point, list);
    return () => { const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1); };
  }

  async apply(point: string, envelope: InterceptorEnvelope) {
    if (!this.extensionPoints.has(point)) throw new CompositionError("UNKNOWN_EXTENSION_POINT");
    const snapshot = immutableSnapshot(envelope);
    const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
    let denied = false;
    for (const interceptor of [...this.interceptors.get(point) ?? []]) {
      // Strict output schema rejects attempts to replace captured actor, permissions or approval.
      let raw: unknown;
      try { raw = await this.bounded(() => interceptor.callback(snapshot)); }
      catch (error) {
        if (error instanceof CompositionError && error.code === "HOOK_TIMEOUT") throw error;
        throw new CompositionError("INTERCEPTOR_FAILED");
      }
      let result: InterceptorResult;
      try { result = interceptorResult.parse(raw); }
      catch { throw new CompositionError("INTERCEPTOR_INVALID_RESULT"); }
      denied ||= result.deny === true;
      Object.assign(metadata, result.metadata);
    }
    return { envelope: snapshot, denied, metadata: Object.freeze(metadata) };
  }

  private async bounded<T>(callback: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(callback), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CompositionError("HOOK_TIMEOUT")), this.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
