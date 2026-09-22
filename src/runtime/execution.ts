import { randomUUID } from "node:crypto";
import { AuditStore } from "../audit/store.js";
import type {
  AuditAttribution,
  AuditEvent,
  ExecutionPhase,
  RecoveryHint
} from "../audit/types.js";
import {
  DEFAULT_CAPABILITY_CATALOG,
  type CapabilityCatalog
} from "../capability/registry.js";
import type { LiveActivityStore } from "../monitor/live-activity.js";
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
  readonly #liveActivity?: LiveActivityStore;
  readonly #attribution?: AuditAttribution;

  constructor(
    audit: AuditStore,
    workspaceId: () => string,
    catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG,
    liveActivity?: LiveActivityStore,
    attribution?: AuditAttribution
  ) {
    this.#audit = audit;
    this.#workspaceId = workspaceId;
    this.#catalog = catalog;
    this.#liveActivity = liveActivity;
    this.#attribution = attribution ? { ...attribution } : undefined;
  }

  async run<T>(
    capability: string,
    operationOrPlan: (() => Promise<T>) | ExecutionPlan<T>,
    liveDetail?: string,
    attribution?: Partial<AuditAttribution>
  ): Promise<T> {
    const descriptor = this.#catalog.descriptor(capability);
    const plan: ExecutionPlan<T> = typeof operationOrPlan === "function"
      ? { execute: operationOrPlan }
      : operationOrPlan;

    const id = randomUUID();
    const started = Date.now();
    let phase: ExecutionPhase = "prepare";
    const workspaceId = this.#workspaceId();
    const effectiveAttribution = {
      ...(this.#attribution ?? {}),
      ...(attribution ?? {})
    };

    const base: AuditEvent = {
      id,
      capability,
      scope: descriptor.scope,
      workspaceId,
      ...(effectiveAttribution.source
        ? { source: effectiveAttribution.source }
        : {}),
      ...(effectiveAttribution.transport
        ? { transport: effectiveAttribution.transport }
        : {}),
      ...(effectiveAttribution.runtimeSlot
        ? { runtimeSlot: effectiveAttribution.runtimeSlot }
        : {}),
      ...(effectiveAttribution.principal
        ? { principal: effectiveAttribution.principal }
        : {}),
      ...(effectiveAttribution.clientName
        ? { clientName: effectiveAttribution.clientName }
        : {}),
      ...(effectiveAttribution.clientVersion
        ? { clientVersion: effectiveAttribution.clientVersion }
        : {}),
      state: "running",
      phase,
      startedAt: new Date(started).toISOString(),
      recoveryHint: "inspect"
    };

    const liveBase = {
      id,
      capability,
      risk: descriptor.risk,
      scope: descriptor.scope,
      workspaceId,
      ...(effectiveAttribution.source
        ? { source: effectiveAttribution.source }
        : {}),
      ...(effectiveAttribution.transport
        ? { transport: effectiveAttribution.transport }
        : {}),
      ...(effectiveAttribution.runtimeSlot
        ? { runtimeSlot: effectiveAttribution.runtimeSlot }
        : {}),
      ...(effectiveAttribution.principal
        ? { principal: effectiveAttribution.principal }
        : {}),
      ...(effectiveAttribution.clientName
        ? { clientName: effectiveAttribution.clientName }
        : {}),
      ...(effectiveAttribution.clientVersion
        ? { clientVersion: effectiveAttribution.clientVersion }
        : {}),
      summary: descriptor.summary,
      ...(liveDetail ? { detail: liveDetail } : {}),
      startedAt: base.startedAt
    };

    const mark = (nextPhase: ExecutionPhase): void => {
      phase = nextPhase;
      this.#audit.upsert({ ...base, phase, state: "running" });
      this.#liveActivity?.upsert({
        ...liveBase,
        state: "running",
        phase
      });
    };

    this.#audit.upsert(base);
    this.#liveActivity?.upsert({
      ...liveBase,
      state: "running",
      phase
    });

    try {
      mark("authorize");
      if (plan.authorize) await plan.authorize();

      mark("execute");
      const result = await plan.execute();

      mark("verify");
      if (plan.verify) await plan.verify(result);

      const finished = Date.now();
      const finishedAt = new Date(finished).toISOString();
      this.#audit.upsert({
        ...base,
        phase: "complete",
        state: "succeeded",
        finishedAt,
        durationMs: finished - started,
        recoveryHint: "none"
      });
      this.#liveActivity?.upsert({
        ...liveBase,
        state: "succeeded",
        phase: "complete",
        finishedAt,
        durationMs: finished - started
      });
      return result;
    } catch (error) {
      const finished = Date.now();
      const finishedAt = new Date(finished).toISOString();
      const category = classifyError(error);
      this.#audit.upsert({
        ...base,
        phase,
        state: "failed",
        finishedAt,
        durationMs: finished - started,
        errorCategory: category,
        recoveryHint: recoveryHint(category)
      });
      this.#liveActivity?.upsert({
        ...liveBase,
        state: "failed",
        phase,
        finishedAt,
        durationMs: finished - started,
        errorCategory: category
      });
      throw error;
    }
  }
}
