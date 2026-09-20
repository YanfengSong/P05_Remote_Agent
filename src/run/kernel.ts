import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../runtime/context.js";
import type { StateStore } from "../storage/types.js";
import type {
  JsonValue,
  RunEvent,
  RunFilter,
  RunRecord,
  RunRecoveryHint,
  RunState
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function terminal(state: RunState): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(state);
}

export class DurableRunKernel {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  create(args: {
    id?: string;
    kind: string;
    parentRunId?: string;
    context: ExecutionContext;
    ownerType: string;
    state?: RunState;
    recoveryHint?: RunRecoveryHint;
    domain?: Record<string, JsonValue>;
    eventType?: string;
    eventPayload?: Record<string, JsonValue>;
  }): RunRecord {
    const id = args.id ?? "run-" + randomUUID();
    if (this.#store.getRun(id)) throw new Error('Run "' + id + '" already exists.');
    if (args.parentRunId && !this.#store.getRun(args.parentRunId)) {
      throw new Error('Parent run "' + args.parentRunId + '" does not exist.');
    }

    const createdAt = now();
    const state = args.state ?? "CREATED";
    const run: RunRecord = {
      id,
      kind: args.kind,
      ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
      context: {
        ...args.context,
        actor: { ...args.context.actor },
        authority: { ...args.context.authority },
        ...(args.context.isolation ? { isolation: { ...args.context.isolation } } : {})
      },
      state,
      ownerType: args.ownerType,
      createdAt,
      updatedAt: createdAt,
      ...(state === "RUNNING" ? { startedAt: createdAt } : {}),
      ...(terminal(state) ? { finishedAt: createdAt } : {}),
      recoveryHint: args.recoveryHint ?? (terminal(state) ? "none" : "inspect"),
      sequence: 1,
      domain: { ...(args.domain ?? {}) }
    };
    const event: RunEvent = {
      runId: id,
      sequence: 1,
      type: args.eventType ?? "run.created",
      at: createdAt,
      payload: { ...(args.eventPayload ?? {}) }
    };
    this.#store.createRun(run, event);
    return this.get(id);
  }

  get(id: string): RunRecord {
    const run = this.#store.getRun(id);
    if (!run) throw new Error('Unknown run "' + id + '".');
    return run;
  }

  maybe(id: string): RunRecord | undefined {
    return this.#store.getRun(id);
  }

  list(filter?: RunFilter): RunRecord[] {
    return this.#store.listRuns(filter);
  }

  events(id: string, afterSequence = 0, limit = 200): RunEvent[] {
    this.get(id);
    return this.#store.listRunEvents(id, afterSequence, limit);
  }

  transition(id: string, args: {
    state?: RunState;
    eventType: string;
    eventPayload?: Record<string, JsonValue>;
    domainPatch?: Record<string, JsonValue>;
    recoveryHint?: RunRecoveryHint;
  }): RunRecord {
    const current = this.get(id);
    const changed = now();
    const state = args.state ?? current.state;
    const next: RunRecord = {
      ...current,
      state,
      updatedAt: changed,
      ...(!current.startedAt && state === "RUNNING" ? { startedAt: changed } : {}),
      ...(terminal(state) ? { finishedAt: changed } : {}),
      recoveryHint: args.recoveryHint ?? current.recoveryHint,
      sequence: current.sequence + 1,
      domain: { ...current.domain, ...(args.domainPatch ?? {}) }
    };
    const event: RunEvent = {
      runId: id,
      sequence: next.sequence,
      type: args.eventType,
      at: changed,
      payload: { ...(args.eventPayload ?? {}) }
    };
    this.#store.updateRunAndAppendEvent(next, event);
    return this.get(id);
  }

  interrupt(id: string, reason = "restart"): RunRecord {
    const current = this.get(id);
    if (terminal(current.state)) return current;
    return this.transition(id, {
      state: "INTERRUPTED",
      eventType: "run.interrupted",
      eventPayload: { reason },
      recoveryHint: "inspect"
    });
  }
}
