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
import {
  isOutcome,
  isOutcomeFailure,
  type Outcome
} from "../tools/file-contracts.js";
import { classifyError, type ErrorCategory } from "./errors.js";

export type ExecutionAuthorizationContext = {
  approvalId?: string;
  operation?: string;
};

export type ExecutionPlan<T> = {
  authorize?: () => void | Promise<void>;
  execute: () => Promise<T>;
  verify?: (result: T) => void | Promise<void>;
  authorizationContext?: () => ExecutionAuthorizationContext | undefined;
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

type ResultClassification = {
  failed: boolean;
  outcome?: Outcome;
  truncated: boolean;
};

function classifyToolResult(result: unknown): ResultClassification {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { failed: false, truncated: false };
  }

  const record = result as {
    isError?: unknown;
    structuredContent?: unknown;
  };
  const isError = record.isError === true;
  let outcome: Outcome | undefined;
  let structured: Record<string, unknown> | undefined;
  if (
    record.structuredContent &&
    typeof record.structuredContent === "object" &&
    !Array.isArray(record.structuredContent)
  ) {
    structured = record.structuredContent as Record<string, unknown>;
    const candidate = structured.outcome;
    if (isOutcome(candidate)) outcome = candidate;
  }

  const pending = Array.isArray(structured?.pendingIndexes) &&
    structured.pendingIndexes.length > 0;
  const incompleteFile = Array.isArray(structured?.files) &&
    structured.files.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const file = item as Record<string, unknown>;
      return file.ok === true && file.complete === false;
    });
  const coverage = structured?.coverage;
  const incompleteCoverage =
    Boolean(coverage) &&
    typeof coverage === "object" &&
    !Array.isArray(coverage) &&
    (coverage as Record<string, unknown>).complete === false;
  const responseTruncated = structured?.responseTruncated === true;

  return {
    failed: isError || (outcome !== undefined && isOutcomeFailure(outcome)),
    truncated:
      pending ||
      incompleteFile ||
      incompleteCoverage ||
      responseTruncated ||
      (outcome !== undefined &&
        (outcome.code === "READ_TRUNCATED" || outcome.code === "SEARCH_TRUNCATED")),
    ...(outcome ? { outcome } : {})
  };
}

function outcomeErrorCategory(outcome: Outcome): ErrorCategory {
  if (outcome.status === "unknown" || outcome.effectState === "unknown") {
    return "unknown";
  }
  if (outcome.code === "READ_LIMIT_INVALID") return "config";
  if (
    outcome.code === "PATH_REFUSED" ||
    outcome.code === "ACCESS_DENIED" ||
    outcome.code === "SYMLINK_REFUSED" ||
    outcome.code === "HARDLINK_REFUSED" ||
    outcome.code === "NOT_REGULAR_FILE" ||
    outcome.code === "IS_DIRECTORY"
  ) {
    return "policy";
  }
  return "tool";
}

function outcomeRecoveryHint(outcome: Outcome): RecoveryHint {
  return outcome.retry === "never_automatic" ? "human" : "inspect";
}

function resultAuditFields(
  classification: ResultClassification
): Pick<
  AuditEvent,
  "resultStatus" | "resultCode" | "resultEffectState" | "resultRetry" | "resultTruncated"
> {
  const outcome = classification.outcome;
  if (!outcome) {
    return classification.truncated ? { resultTruncated: true } : {};
  }
  return {
    resultStatus: outcome.status,
    resultCode: outcome.code,
    resultEffectState: outcome.effectState,
    resultRetry: outcome.retry,
    resultTruncated: classification.truncated
  };
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
      ...(liveDetail ? { inputSummary: liveDetail } : {}),
      state: "running",
      phase,
      startedAt: new Date(started).toISOString(),
      recoveryHint: "inspect"
    };

    const authorizationFields = (): Pick<
      AuditEvent,
      "approvalId" | "authorizationOperation"
    > => {
      const context = plan.authorizationContext?.();
      return {
        ...(context?.approvalId ? { approvalId: context.approvalId } : {}),
        ...(context?.operation
          ? { authorizationOperation: context.operation }
          : {})
      };
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
      this.#audit.upsert({
        ...base,
        ...authorizationFields(),
        phase,
        state: "running"
      });
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
      const classification = classifyToolResult(result);
      const resultFields = resultAuditFields(classification);

      if (classification.failed) {
        const category = classification.outcome
          ? outcomeErrorCategory(classification.outcome)
          : "tool";
        const hint = classification.outcome
          ? outcomeRecoveryHint(classification.outcome)
          : "inspect";
        this.#audit.upsert({
          ...base,
          ...authorizationFields(),
          phase: "complete",
          state: "failed",
          finishedAt,
          durationMs: finished - started,
          errorCategory: category,
          recoveryHint: hint,
          ...resultFields
        });
        this.#liveActivity?.upsert({
          ...liveBase,
          state: "failed",
          phase: "complete",
          finishedAt,
          durationMs: finished - started,
          errorCategory: category
        });
        return result;
      }

      this.#audit.upsert({
        ...base,
        ...authorizationFields(),
        phase: "complete",
        state: "succeeded",
        finishedAt,
        durationMs: finished - started,
        recoveryHint: "none",
        ...resultFields
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
        ...authorizationFields(),
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
