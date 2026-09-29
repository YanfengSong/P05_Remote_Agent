/** Restart accounting is independent of process discovery: callers must own the process. */
export interface SupervisionSnapshot {
  state: "healthy" | "suspect" | "backoff" | "crash_loop";
  crashes: number[];
  lastHeartbeatAt: number;
  nextRestartAt: number | null;
}

export class RestartBudget {
  private crashes: number[];
  private lastHeartbeatAt: number;
  private nextRestartAt: number | null;
  private latched: boolean;

  constructor(private readonly options: {
    now?: () => number;
    random?: () => number;
    heartbeatMs?: number;
    missedHeartbeats?: number;
    windowMs?: number;
    maxCrashes?: number;
    initial?: SupervisionSnapshot;
  } = {}) {
    for (const value of [options.heartbeatMs, options.missedHeartbeats, options.windowMs, options.maxCrashes]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("INVALID_SUPERVISION_BUDGET");
    }
    this.crashes = [...(options.initial?.crashes ?? [])];
    this.lastHeartbeatAt = options.initial?.lastHeartbeatAt ?? this.now();
    this.nextRestartAt = options.initial?.nextRestartAt ?? null;
    this.latched = options.initial?.state === "crash_loop";
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  heartbeat(): void { this.lastHeartbeatAt = this.now(); }

  recordCrash(): SupervisionSnapshot {
    const now = this.now();
    this.crashes = this.crashes.filter((at) => now - at < (this.options.windowMs ?? 300_000));
    this.crashes.push(now);
    if (this.crashes.length >= (this.options.maxCrashes ?? 3)) this.latched = true;
    const jitter = Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
    this.nextRestartAt = this.latched ? null : now + Math.min(60_000, 1_000 * 2 ** (this.crashes.length - 1)) + Math.floor(jitter * 250);
    return this.snapshot();
  }

  canRestart(): boolean {
    return !this.latched && (this.nextRestartAt === null || this.now() >= this.nextRestartAt);
  }

  /** Only call through an authenticated maintenance decision; time alone does not unlatch. */
  reset(): void {
    this.crashes = [];
    this.latched = false;
    this.nextRestartAt = null;
    this.heartbeat();
  }

  snapshot(): SupervisionSnapshot {
    const state = this.latched ? "crash_loop"
      : !this.canRestart() ? "backoff"
      : this.now() - this.lastHeartbeatAt >= (this.options.heartbeatMs ?? 10_000) * (this.options.missedHeartbeats ?? 3) ? "suspect"
      : "healthy";
    return { state, crashes: [...this.crashes], lastHeartbeatAt: this.lastHeartbeatAt, nextRestartAt: this.nextRestartAt };
  }
}
