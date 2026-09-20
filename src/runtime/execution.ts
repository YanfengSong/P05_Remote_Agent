import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AuditStore } from "../audit/store.js";
import type {
  AuditEvent,
  ExecutionPhase,
  RecoveryHint
} from "../audit/types.js";
import { DEFAULT_CAPABILITY_CATALOG, type CapabilityCatalog } from "../capability/registry.js";
import type { ActorType } from "./context.js";
import { classifyError, type ErrorCategory } from "./errors.js";

export type ExecutionCorrelation = {
  sessionId?: string;
  actorType?: ActorType;
  actorId?: string;
  taskId?: string;
};

type ExecutionStore = {
  executionId: string;
  correlation: ExecutionCorrelation;
};

const executionStorage = new AsyncLocalStorage<ExecutionStore>();

export function currentExecutionId(): string | undefined {
  return executionStorage.getStore()?.executionId;
}

export function attachExecutionCorrelation(
  correlation: ExecutionCorrelation,
  overwrite = false
): void {
  const store = executionStorage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(correlation)) {
    if (value === undefined) continue;
    const typedKey = key as keyof ExecutionCorrelation;
    if (overwrite || store.correlation[typedKey] === undefined) {
      (store.correlation as Record<string, unknown>)[typedKey] = value;
    }
  }
}

export type ExecutionPlan<T> = {
  authorize?: () => void | Promise<void>;
  execute: () => Promise<T>;
  verify?: (result: T) => void | Promise<void>;
};

function recoveryHint(category: ErrorCategory): RecoveryHint {
  switch (category) {
    case "policy":
    case "config":
      return "human";
    case "timeout":
      return "retry";
    case "process":
    case "tool":
    case "interrupted":
    case "unknown":
      return "inspect";
  }
}

export class ExecutionRuntime {
  readonly #audit: AuditStore;
  readonly #workspaceId: () => string;
  readonly #catalog: CapabilityCatalog;

  constructor(
    audit: AuditStore,
    workspaceId: () => string,
    catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG
  ) {
    this.#audit = audit;
    this.#workspaceId = workspaceId;
    this.#catalog = catalog;
  }

  async run<T>(
    capability: string,
    operationOrPlan: (() => Promise<T>) | ExecutionPlan<T>
  ): Promise<T> {
    const descriptor = this.#catalog.descriptor(capability);
    const plan: ExecutionPlan<T> = typeof operationOrPlan === "function"
      ? { execute: operationOrPlan }
      : operationOrPlan;

    const id = randomUUID();
    const store: ExecutionStore = { executionId: id, correlation: {} };

    return executionStorage.run(store, async () => {
      const started = Date.now();
      let phase: ExecutionPhase = "prepare";

      const event = (args: Partial<AuditEvent>): AuditEvent => ({
        id,
        capability,
        scope: descriptor.scope,
        workspaceId: this.#workspaceId(),
        ...store.correlation,
        state: "running",
        phase,
        startedAt: new Date(started).toISOString(),
        recoveryHint: "inspect",
        ...args
      });

      const mark = (nextPhase: ExecutionPhase): void => {
        phase = nextPhase;
        this.#audit.upsert(event({ phase, state: "running" }));
      };

      this.#audit.upsert(event({}));

      try {
        mark("authorize");
        if (plan.authorize) await plan.authorize();

        mark("execute");
        const result = await plan.execute();

        mark("verify");
        if (plan.verify) await plan.verify(result);

        const finished = Date.now();
        this.#audit.upsert(event({
          phase: "complete",
          state: "succeeded",
          finishedAt: new Date(finished).toISOString(),
          durationMs: finished - started,
          recoveryHint: "none"
        }));
        return result;
      } catch (error) {
        const finished = Date.now();
        const category = classifyError(error);
        this.#audit.upsert(event({
          phase,
          state: "failed",
          finishedAt: new Date(finished).toISOString(),
          durationMs: finished - started,
          errorCategory: category,
          recoveryHint: recoveryHint(category)
        }));
        throw error;
      }
    });
  }
}
