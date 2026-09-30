import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod/v4";
import { createRpcClient } from "./transport/rpc.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";
import { DurableError, ExecutionDetached, ExecutionFailure, UnconfirmedOutcome, type Capability, type Json, type Run } from "./durable/types.js";
import type { ProcessOwner } from "./process/host.js";
import { secretArgumentSchema, type SecretResolver } from "./secrets.js";

export const processRunInputSchema = z.object({
  executable: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && !value.includes("\0")),
  args: z.array(z.union([z.string().max(32768).refine((value) => !value.includes("\0")), secretArgumentSchema])).max(256)
}).strict();
export const PROCESS_CAPABILITY_METADATA = [{
  capability: "process_run", effect: "E4", authority: ["HostExecute"], securityMode: "trusted-host",
  filesystemIsolation: false, networkIsolation: false, processTreeTermination: "unconfirmed",
  inputSchema: z.toJSONSchema(processRunInputSchema)
}] as const;

const connectionSchema = z.object({
  version: z.literal(1), url: z.string().max(2048), clientTokenFile: z.string().refine(path.isAbsolute),
  slot: z.string().min(1).max(80), principal: z.string().min(1).max(160), workspaceRoot: z.string().refine(path.isAbsolute),
  securityMode: z.literal("trusted-host")
}).strict();
const ownerSchema = z.object({ slot: z.string(), principal: z.string(), runId: z.string(), attemptId: z.string() }).strict();
const receiptSchema = z.object({
  kind: z.enum(["exit", "spawn_failed", "unknown"]), executorBootId: z.string().uuid(), at: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable().optional(), signal: z.string().nullable().optional(),
  directTermination: z.enum(["confirmed", "unconfirmed"]), treeTermination: z.literal("unconfirmed"), cancelRequested: z.boolean(), reason: z.string().max(120).optional()
}).strict();
const processViewSchema = z.object({
  id: z.string().uuid(), dispatchKey: z.string(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), owner: ownerSchema, executorBootId: z.string().uuid(),
  state: z.enum(["REGISTERED", "RUNNING", "CANCEL_REQUESTED", "EXITED", "FAILED", "UNKNOWN"]),
  stdoutBytes: z.number().int().nonnegative(), stderrBytes: z.number().int().nonnegative(), truncated: z.boolean(), receipt: receiptSchema.optional()
}).strict();
type ProcessView = z.infer<typeof processViewSchema>;
export type ProcessBridgeOptions = {
  connectionFile: string; slotId: string; principal: string; workspaceRoot: string;
  pollIntervalMs?: number; rpcTimeoutMs?: number; maxPollMs?: number; summaryBytes?: number; secretResolver?: SecretResolver;
};

function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new DurableError("INVALID_PROCESS_BRIDGE_LIMIT", "Invalid Process bridge limit");
  return result;
}
function normalize(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function separate(target: string, workspace: string): boolean {
  const child = normalize(path.resolve(target)), root = normalize(workspace);
  return child !== root && !child.startsWith(root + path.sep);
}
function plain<T>(value: T): Json { return JSON.parse(JSON.stringify(value)) as Json; }

export function validateProcessInput(capability: string, input: Json): void {
  if (capability !== "process_run") throw new DurableError("UNKNOWN_CAPABILITY", "Unknown process capability");
  processRunInputSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(input)) > 240 * 1024) throw new DurableError("PROCESS_INPUT_LIMIT", "Process input exceeds the bridge limit");
}

/** Load only from local trusted configuration. No launch/stop ownership over the external Host. */
export async function createProcessBridge(configuredOptions: ProcessBridgeOptions) {
  const options = Object.freeze({ ...configuredOptions });
  if (!path.isAbsolute(options.connectionFile) || !path.isAbsolute(options.workspaceRoot)) throw new DurableError("PROCESS_CONNECTION_INVALID", "Explicit absolute paths are required");
  const workspaceRoot = fs.realpathSync(options.workspaceRoot);
  const connectionFile = fs.realpathSync(options.connectionFile);
  if (!separate(connectionFile, workspaceRoot)) throw new DurableError("PROCESS_CONNECTION_IN_WORKSPACE", "Connection credentials must stay outside the work workspace");
  if (!(await verifyStateProtection(path.dirname(connectionFile))).verified || !(await verifyConfigurationProtection(connectionFile)).verified) throw new DurableError("PROCESS_CONNECTION_UNPROTECTED", "Connection protection is unverified");
  if (fs.statSync(connectionFile).size > 64 * 1024) throw new DurableError("PROCESS_CONNECTION_INVALID", "Connection file exceeds the size limit");
  const connection = connectionSchema.parse(JSON.parse(fs.readFileSync(connectionFile, "utf8")));
  if (connection.slot !== options.slotId || connection.principal !== options.principal || normalize(fs.realpathSync(connection.workspaceRoot)) !== normalize(workspaceRoot)) throw new DurableError("PROCESS_BINDING_MISMATCH", "Process connection identity does not match Core");
  const clientTokenFile = fs.realpathSync(connection.clientTokenFile);
  if (!separate(clientTokenFile, workspaceRoot) || !(await verifyStateProtection(path.dirname(clientTokenFile))).verified || !(await verifyConfigurationProtection(clientTokenFile)).verified) throw new DurableError("PROCESS_CREDENTIAL_UNPROTECTED", "Executor credential protection is unverified");
  if (fs.statSync(clientTokenFile).size > 1024) throw new DurableError("PROCESS_CREDENTIAL_INVALID", "Invalid executor credential");
  const rpcTimeoutMs = bound(options.rpcTimeoutMs, 5000, 50, 120000);
  const pollIntervalMs = bound(options.pollIntervalMs, 100, 10, 5000);
  const maxPollMs = bound(options.maxPollMs, 600000, 100, 3600000);
  const summaryBytes = bound(options.summaryBytes, 8192, 1, 24576);
  const rpc = createRpcClient({ url: connection.url, token: fs.readFileSync(clientTokenFile, "utf8").trim(), timeoutMs: rpcTimeoutMs });
  const bindingDigest = createHash("sha256").update(JSON.stringify([options.slotId, options.principal, workspaceRoot])).digest("hex");
  const healthSchema = z.object({ alive: z.literal(true), executorBootId: z.string().uuid(), bindingDigest: z.literal(bindingDigest), mode: z.literal("trusted-host"), filesystemIsolation: z.literal(false), networkIsolation: z.literal(false), processTreeTermination: z.literal("unconfirmed"), storageFault: z.literal(false), activeProcesses: z.number().int().nonnegative(), pendingDispatches: z.number().int().nonnegative() }).strict();
  const health = async () => healthSchema.parse(await rpc.call("process_health", {}));
  await health();

  const ownerFor = (run: Readonly<Run>): ProcessOwner => {
    if (run.capability !== "process_run" || run.context.slotId !== options.slotId || run.context.principal !== options.principal || normalize(run.context.workspaceRoot) !== normalize(workspaceRoot)) throw new DurableError("PROCESS_RUN_BINDING_MISMATCH", "Run context does not match the fixed executor binding");
    return { slot: options.slotId, principal: options.principal, runId: run.executionId, attemptId: `${run.executionId}:attempt1` };
  };
  const dispatchKeyFor = (run: Readonly<Run>) => `${run.executionId}:attempt1`;
  const checkedView = (raw: unknown, run: Readonly<Run>, expectedDigest?: string): ProcessView => {
    const view = processViewSchema.parse(raw);
    if (view.dispatchKey !== dispatchKeyFor(run) || JSON.stringify(view.owner) !== JSON.stringify(ownerFor(run)) ||
      (expectedDigest !== undefined && view.inputDigest !== expectedDigest) || (view.receipt && view.receipt.executorBootId !== view.executorBootId)) throw new DurableError("PROCESS_RECEIPT_MISMATCH", "Executor receipt does not match the original Run");
    return view;
  };
  const statusForRun = async (run: Readonly<Run>) => checkedView(await rpc.call("process_lookup", { dispatchKey: dispatchKeyFor(run), owner: ownerFor(run) }), run);
  const outputForView = async (run: Readonly<Run>, view: ProcessView, request: { stream?: "stdout" | "stderr"; offset?: number; limit?: number } = {}) => {
    const stream = request.stream ?? "stdout";
    const offset = request.offset ?? 0;
    const limit = bound(request.limit, 65536, 1, 65536);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DurableError("PROCESS_OUTPUT_OFFSET", "Invalid byte offset");
    const value = z.object({ id: z.literal(view.id), stream: z.literal(stream), offset: z.literal(offset), nextOffset: z.number().int().nonnegative(), dataBase64: z.string().max(Math.ceil(limit / 3) * 4), truncated: z.boolean(), availableBytes: z.number().int().nonnegative() }).strict().parse(await rpc.call("process_output", { id: view.id, owner: ownerFor(run), stream, offset, limit }));
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== value.dataBase64 || value.nextOffset !== offset + bytes.length || value.nextOffset > value.availableBytes) throw new DurableError("PROCESS_OUTPUT_INVALID", "Executor output page is inconsistent");
    return value;
  };
  const outputForRun = async (run: Readonly<Run>, request: { stream?: "stdout" | "stderr"; offset?: number; limit?: number } = {}) => outputForView(run, await statusForRun(run), request);
  const reference = (run: Readonly<Run>, view?: ProcessView): Json => plain({ executionId: run.executionId, dispatchKey: dispatchKeyFor(run), ...(view ? { processId: view.id, executorBootId: view.executorBootId, processState: view.state, receipt: view.receipt } : {}), automaticRetryAllowed: false, processTreeTermination: "unconfirmed" });
  // A terminal Core observation may still have live external work. Never redispatch to cancel it.
  const cancelForRun = async (run: Readonly<Run>): Promise<ProcessView> => {
    const owner = ownerFor(run);
    let view: ProcessView | undefined;
    try {
      view = await statusForRun(run);
      const cancelled = checkedView(await rpc.call("process_cancel", { id: view.id, owner }), run, view.inputDigest);
      if (cancelled.id !== view.id) throw new DurableError("PROCESS_RECEIPT_MISMATCH", "Executor cancellation changed the original task");
      return cancelled;
    } catch { throw new UnconfirmedOutcome("PROCESS_CANCEL_UNCONFIRMED", reference(run, view)); }
  };
  const metadata = PROCESS_CAPABILITY_METADATA;
  const capabilities: Capability[] = [{
    capability: "process_run", capabilityVersion: "1", bindingVersion: `external-process-v1.${createHash("sha256").update(JSON.stringify([connection.url, bindingDigest])).digest("hex").slice(0, 16)}`,
    async execute({ run, input, signal }) {
      validateProcessInput("process_run", input);
      const request = processRunInputSchema.parse(input);
      const owner = ownerFor(run);
      const dispatchKey = dispatchKeyFor(run);
      const resolvedArgs: string[] = [];
      const secretValues: string[] = [];
      for (const argument of request.args) {
        if (typeof argument === "string") { resolvedArgs.push(argument); continue; }
        if (!options.secretResolver) throw new ExecutionFailure("SECRET_RESOLVER_UNAVAILABLE", { dispatched: false });
        let secret: string;
        try { secret = await options.secretResolver.resolveForExecution(argument, { principalId: run.context.principal, workspaceId: run.context.workspaceId, purpose: "process-argument" }); }
        catch { throw new ExecutionFailure("SECRET_RESOLUTION_FAILED", { dispatched: false }); }
        if (typeof secret !== "string" || secret.length < 4 || secret.length > 4096 || secret.includes("\0")) throw new ExecutionFailure("SECRET_RESOLUTION_FAILED", { dispatched: false });
        secretValues.push(secret);
        resolvedArgs.push(argument.prefix + secret + argument.suffix);
      }
      if (signal.aborted && signal.reason instanceof ExecutionDetached) throw new UnconfirmedOutcome("PROCESS_CORE_DETACHED", reference(run));
      if (signal.aborted) throw new ExecutionFailure("PROCESS_ABORTED_BEFORE_SUBMIT", { dispatched: false });
      const expectedDigest = createHash("sha256").update(JSON.stringify([request.executable, resolvedArgs, workspaceRoot, JSON.stringify([owner.slot, owner.principal, owner.runId, owner.attemptId])])).digest("hex");
      let view: ProcessView | undefined;
      try {
        const response = await rpc.call("process_submit", { executable: request.executable, args: resolvedArgs, redactions: secretValues, dispatchKey, owner });
        const code = (response as { error?: { code?: unknown } } | null)?.error?.code;
        if (typeof code === "string" && ["OWNER_MISMATCH", "INVALID_INPUT", "INVALID_COMMAND", "INPUT_TOO_LARGE", "HOST_BUSY", "HOST_UNAVAILABLE", "RECEIPT_CAPACITY_REACHED", "DISPATCH_CONFLICT"].includes(code)) throw new ExecutionFailure("PROCESS_SUBMIT_REJECTED", { code, dispatchKey });
        view = checkedView(response, run, expectedDigest);
      } catch (error) {
        if (error instanceof ExecutionFailure) throw error;
        throw new UnconfirmedOutcome("PROCESS_SUBMIT_UNCONFIRMED", reference(run));
      }
      const deadline = performance.now() + maxPollMs;
      let cancelSent = false;
      while (true) {
        if (signal.aborted && signal.reason instanceof ExecutionDetached) throw new UnconfirmedOutcome("PROCESS_CORE_DETACHED", reference(run, view));
        if (view.state === "UNKNOWN") throw new UnconfirmedOutcome("PROCESS_OUTCOME_UNKNOWN", reference(run, view));
        if (["EXITED", "FAILED"].includes(view.state)) {
          if (!view.receipt || view.receipt.directTermination !== "confirmed") throw new UnconfirmedOutcome("PROCESS_EXIT_UNCONFIRMED", reference(run, view));
          let stdout, stderr;
          try {
            stdout = await outputForView(run, view, { stream: "stdout", limit: summaryBytes });
            stderr = await outputForView(run, view, { stream: "stderr", limit: summaryBytes });
          } catch { throw new UnconfirmedOutcome("PROCESS_OUTPUT_UNAVAILABLE", reference(run, view)); }
          const evidence = plain({ processId: view.id, dispatchKey, executorBootId: view.executorBootId, receipt: view.receipt,
            stdout: { text: Buffer.from(stdout.dataBase64, "base64").toString("utf8"), nextOffset: stdout.nextOffset, availableBytes: stdout.availableBytes },
            stderr: { text: Buffer.from(stderr.dataBase64, "base64").toString("utf8"), nextOffset: stderr.nextOffset, availableBytes: stderr.availableBytes },
            truncated: view.truncated || stdout.nextOffset < stdout.availableBytes || stderr.nextOffset < stderr.availableBytes,
            securityMode: "trusted-host", processTreeTermination: "unconfirmed" });
          if (view.receipt.cancelRequested) throw new UnconfirmedOutcome("PROCESS_CANCEL_TREE_UNCONFIRMED", evidence);
          if (view.state === "FAILED" || view.receipt.kind !== "exit" || view.receipt.exitCode !== 0 || view.receipt.signal !== null) throw new ExecutionFailure("PROCESS_EXIT_FAILED", evidence);
          return evidence;
        }
        if (performance.now() >= deadline) throw new UnconfirmedOutcome("PROCESS_OBSERVATION_DEADLINE", reference(run, view));
        try {
          if (signal.aborted && !cancelSent) {
            cancelSent = true;
            view = checkedView(await rpc.call("process_cancel", { id: view.id, owner }), run, expectedDigest);
          } else {
            await sleep(pollIntervalMs);
            view = checkedView(await rpc.call("process_status", { id: view.id, owner }), run, expectedDigest);
          }
        } catch { throw new UnconfirmedOutcome("PROCESS_CONNECTION_UNCONFIRMED", reference(run, view)); }
      }
    }
  }];
  return { capabilities, metadata, validateInput: validateProcessInput, health, statusForRun, outputForRun, cancelForRun };
}
