import { createHash } from "node:crypto";
import { digest } from "./durable/store.js";
import { DurableError, issueReconciliationProof, type Json, type ReconciliationSnapshot, type ReconciliationPlan, type VerifiedReconciliationProof } from "./durable/types.js";
import { processRunInputSchema, type createProcessBridge } from "./process-bridge.js";

type Bridge = Awaited<ReturnType<typeof createProcessBridge>>;
/** Constructed only by the trusted Store adapter, never from request JSON. */
export type ProcessReconciliationSnapshot = ReconciliationSnapshot;
export type ProcessReconciliationProposal = ReconciliationPlan;
export type ProcessReconciliationInspection =
  | { kind: "CONFIRMED"; proposal: VerifiedReconciliationProof }
  | { kind: "UNCONFIRMED"; code: string; executionId: string; expectedStateVersion: number };

function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
function snapshotDigest(snapshot: ProcessReconciliationSnapshot): string {
  return digest(json({ run: snapshot.run, attempt: snapshot.attempt, cancellationRequested: snapshot.cancellationRequested }));
}

/**
 * Read-only evidence preparation for a future authenticated local Operator port.
 * There is deliberately no commit/dispatch/cancel API or request-supplied receipt.
 * A returned proposal is NOT authorization to write a terminal state: the Store
 * must recheck it in an atomic UNKNOWN/version/attempt/cancellation CAS transaction.
 */
export function createProcessReconciliationInspector(options: {
  bridge: Pick<Bridge, "capabilities" | "statusForRun" | "outputForRun">;
  loadSnapshot(executionId: string): Promise<ProcessReconciliationSnapshot> | ProcessReconciliationSnapshot;
}) {
  const { bridge, loadSnapshot } = options;
  return {
    async inspect(request: { executionId: string; expectedStateVersion: number }): Promise<ProcessReconciliationInspection> {
      if (!request.executionId || request.executionId.length > 160 || !Number.isSafeInteger(request.expectedStateVersion) || request.expectedStateVersion < 1) throw new DurableError("INVALID_ARGUMENT", "Invalid reconciliation request");
      // Copy before awaiting the remote receipt so callers cannot mutate the snapshot.
      const snapshot = JSON.parse(JSON.stringify(await loadSnapshot(request.executionId))) as ProcessReconciliationSnapshot;
      const { run, input, attempt } = snapshot;
      if (run.executionId !== request.executionId || run.state !== "UNKNOWN" || run.stateVersion !== request.expectedStateVersion) throw new DurableError("STATE_CONFLICT", "Reconciliation requires the current UNKNOWN version");
      if (run.capability !== "process_run" || !attempt.id || !attempt.dispatchKey || !["DISPATCHING", "UNCONFIRMED"].includes(attempt.status)) throw new DurableError("RECONCILIATION_NOT_SUPPORTED", "No original Process attempt is available");
      const pending = (code: string): ProcessReconciliationInspection => ({ kind: "UNCONFIRMED", code, executionId: run.executionId, expectedStateVersion: run.stateVersion });
      if (snapshot.cancellationRequested !== false) return pending("PROCESS_CANCELLATION_UNCONFIRMED");
      const binding = bridge.capabilities.find(value => value.capability === "process_run");
      if (!binding || binding.capabilityVersion !== run.capabilityVersion || binding.bindingVersion !== run.bindingVersion) return pending("PROCESS_BINDING_CHANGED");
      const intent = digest({ context: { ...run.context }, capability: run.capability, capabilityVersion: run.capabilityVersion, bindingVersion: run.bindingVersion, input });
      if (digest(input) !== run.inputDigest || intent !== run.intentDigest) throw new DurableError("RECONCILIATION_INPUT_MISMATCH", "Stored Process intent is inconsistent");
      const parsed = processRunInputSchema.parse(input);
      const dispatchKey = `${run.executionId}:attempt1`;
      const owner = { slot: run.context.slotId, principal: run.context.principal, runId: run.executionId, attemptId: dispatchKey };
      const processInputDigest = createHash("sha256").update(JSON.stringify([parsed.executable, parsed.args, run.context.workspaceRoot,
        JSON.stringify([owner.slot, owner.principal, owner.runId, owner.attemptId])])).digest("hex");
      let view: Awaited<ReturnType<Bridge["statusForRun"]>>;
      try { view = await bridge.statusForRun(run); } catch { return pending("PROCESS_RECONCILIATION_UNREACHABLE"); }
      if (view.dispatchKey !== dispatchKey || digest(json(view.owner)) !== digest(json(owner)) || view.inputDigest !== processInputDigest) return pending("PROCESS_RECONCILIATION_IDENTITY_MISMATCH");
      const prior = run.result && typeof run.result === "object" && !Array.isArray(run.result) ? run.result.evidence : undefined;
      if (prior && typeof prior === "object" && !Array.isArray(prior) &&
          ((typeof prior.processId === "string" && prior.processId !== view.id) ||
           (typeof prior.executorBootId === "string" && prior.executorBootId !== view.executorBootId))) return pending("PROCESS_RECONCILIATION_IDENTITY_MISMATCH");
      const receipt = view.receipt;
      if (!receipt || receipt.executorBootId !== view.executorBootId || receipt.directTermination !== "confirmed") return pending("PROCESS_RECEIPT_UNCONFIRMED");
      if (receipt.cancelRequested) return pending("PROCESS_CANCEL_TREE_UNCONFIRMED");
      let outcome: "SUCCEEDED" | "FAILED";
      if (view.state === "EXITED" && receipt.kind === "exit" &&
          (receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) &&
          (receipt.signal === null || typeof receipt.signal === "string") &&
          !(receipt.exitCode === null && receipt.signal === null)) {
        outcome = receipt.exitCode === 0 && receipt.signal === null ? "SUCCEEDED" : "FAILED";
      } else if (view.state === "FAILED" && receipt.kind === "spawn_failed") outcome = "FAILED";
      else return pending("PROCESS_RECEIPT_UNCONFIRMED");
      let stdout, stderr;
      try {
        stdout = await bridge.outputForRun(run, { stream: "stdout", offset: 0, limit: 8192 });
        stderr = await bridge.outputForRun(run, { stream: "stderr", offset: 0, limit: 8192 });
      } catch { return pending("PROCESS_RECONCILIATION_OUTPUT_UNAVAILABLE"); }
      if (stdout.id !== view.id || stderr.id !== view.id) return pending("PROCESS_RECONCILIATION_IDENTITY_MISMATCH");
      const expectedSnapshotDigest = snapshotDigest(snapshot);
      const latest = await loadSnapshot(run.executionId);
      if (snapshotDigest(latest) !== expectedSnapshotDigest) throw new DurableError("STATE_CONFLICT", "Run changed while checking the external receipt");
      const result = json({ processId: view.id, dispatchKey, executorBootId: view.executorBootId, receipt,
        stdout: { text: Buffer.from(stdout.dataBase64, "base64").toString("utf8"), nextOffset: stdout.nextOffset, availableBytes: stdout.availableBytes },
        stderr: { text: Buffer.from(stderr.dataBase64, "base64").toString("utf8"), nextOffset: stderr.nextOffset, availableBytes: stderr.availableBytes },
        truncated: view.truncated || stdout.nextOffset < stdout.availableBytes || stderr.nextOffset < stderr.availableBytes,
        securityMode: "trusted-host", processTreeTermination: "unconfirmed", reconciliation: "verified-original-process-receipt" });
      return { kind: "CONFIRMED", proposal: issueReconciliationProof({ executionId: run.executionId, expectedStateVersion: run.stateVersion,
        expectedSnapshotDigest, coreAttemptId: attempt.id, coreDispatchKey: attempt.dispatchKey, processDispatchKey: dispatchKey,
        inputDigest: run.inputDigest, intentDigest: run.intentDigest, bindingVersion: run.bindingVersion,
        owner: { principal: run.context.principal, slotId: run.context.slotId }, outcome, result, evidenceDigest: digest({ outcome, payload: result }) }) };
    }
  };
}
