import { randomUUID } from "node:crypto";
import { AuditStore } from "../audit/store.js";
import type {
  AuditEvent,
  ExecutionPhase,
  RecoveryHint
} from "../audit/types.js";
import { DEFAULT_CAPABILITY_CATALOG, type CapabilityCatalog } from "../capability/registry.js";
import { classifyError, type ErrorCategory } from "./errors.js";

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
    const started = Date.now();
    let phase: ExecutionPhase = "prepare";

    const base: AuditEvent = {
      id,
      capability,
      scope: descriptor.scope,
      workspaceId: this.#workspaceId(),
      state: "running",
      phase,
      startedAt: new Date(started).toISOString(),
      recoveryHint: "inspect"
    };

    const mark = (nextPhase: ExecutionPhase): void => {
      phase = nextPhase;
      this.#audit.upsert({ ...base, phase, state: "running" });
    };

    this.#audit.upsert(base);

    try {
      mark("authorize");
      if (plan.authorize) await plan.authorize();

      mark("execute");
      const result = await plan.execute();

      mark("verify");
      if (plan.verify) await plan.verify(result);

      const finished = Date.now();
      this.#audit.upsert({
        ...base,
        phase: "complete",
        state: "succeeded",
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        recoveryHint: "none"
      });
      return result;
    } catch (error) {
      const finished = Date.now();
      const category = classifyError(error);
      this.#audit.upsert({
        ...base,
        phase,
        state: "failed",
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        errorCategory: category,
        recoveryHint: recoveryHint(category)
      });
      throw error;
    }
  }
}