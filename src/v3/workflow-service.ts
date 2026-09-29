import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { CoreState } from "./core/index.js";
import type { DurableKernel } from "./durable/kernel.js";
import type { Capability, ExecutionContext } from "./durable/types.js";
import { WorkflowRegistry } from "./workflows/registry.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { WorkflowError, type Json, type SkillDefinition, type RouteDefinition, type WorkflowDefinition, type WorkflowRun } from "./workflows/types.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";

const label = z.string().min(1).max(160);
const query = z.object({ id: label }).strict();
const start = z.object({ workflowId: label, revision: label, input: z.json(), idempotencyKey: z.string().min(1).max(256), reason: z.string().min(1).max(4096) }).strict();

export async function createWorkflowService(options: {
  catalogFile: string; state: CoreState; kernel: DurableKernel; context: ExecutionContext;
  capabilities: Capability[]; authority: string[];
  autoAdvance?: boolean;
}) {
  const file = fs.realpathSync(options.catalogFile);
  const relative = path.relative(fs.realpathSync(options.context.workspaceRoot), file);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("WORKFLOW_CATALOG_IN_WORKSPACE");
  if (!(await verifyConfigurationProtection(file)).verified || !(await verifyStateProtection(path.dirname(file))).verified) {
    throw new Error("WORKFLOW_CATALOG_PROTECTION_UNVERIFIED");
  }
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("WORKFLOW_CATALOG_LIMIT");
  const catalog = z.object({ version: z.literal(1), skills: z.array(z.json()).max(128), routes: z.array(z.json()).max(128), workflows: z.array(z.json()).max(128) }).strict().parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const registry = new WorkflowRegistry({ capabilities: options.capabilities.map(c => ({ capability: c.capability, version: c.capabilityVersion, effect: c.capability === "fs_write" || c.capability === "process_run" ? "write" : "read" })) });
  for (const skill of catalog.skills) registry.registerSkill(skill as unknown as SkillDefinition);
  for (const route of catalog.routes) registry.registerRoute(route as unknown as RouteDefinition);
  for (const workflow of catalog.workflows) registry.registerWorkflow(workflow as unknown as WorkflowDefinition);
  let closed = false;
  const assertOpen = () => { if (closed) throw new WorkflowError("WORKFLOW_SERVICE_CLOSED", "Workflow owner is closed"); };
  const stateKey = (namespace: string, key: string) => "service:workflow:" + createHash("sha256").update(JSON.stringify([namespace, key])).digest("hex");
  const state: import("./workflows/types.js").StateBackend = {
    async read(namespace, key) { assertOpen(); return options.state.readVersioned<Json>(stateKey(namespace, key)); },
    async compareAndSet(namespace, key, expected, value) { assertOpen(); return options.state.compareAndSet(stateKey(namespace, key), expected, value); }
  };
  const engine = new WorkflowEngine({ registry, state, executor: {
    async submit(request) {
      assertOpen();
      const capability = options.capabilities.find(c => c.capability === request.capability);
      if (!capability || capability.capabilityVersion !== request.capabilityVersion) throw new WorkflowError("CAPABILITY_VERSION_CHANGED", "Pinned capability unavailable");
      const required = request.capability === "fs_write" || request.capability === "process_run" ? "WorkspaceWrite" : "Read";
      if (!request.context.authority.includes(required) || !options.authority.includes(required) ||
          Object.entries(options.context).some(([key, value]) => request.context[key as keyof ExecutionContext] !== value)) {
        throw new WorkflowError("SCOPE_ESCALATION", "Invocation exceeds its narrowed scope");
      }
      return options.kernel.submit(options.context, { capability: request.capability, input: request.input, idempotencyKey: request.idempotencyKey });
    },
    async status(_context, id) { assertOpen(); return options.kernel.status(options.context, id); },
    async cancel(_context, id) { assertOpen(); return options.kernel.cancel(options.context, id); }
  } });
  const scheduler = options.autoAdvance === false ? undefined : new WorkflowScheduler({
    state, owner: { principal: options.context.principal, slotId: options.context.slotId }, generation: options.state.identity,
    advance: runId => engine.tick(options.context, runId)
  });
  let discoveryFailures = 0;
  if (scheduler) {
    try {
      await scheduler.start();
      let cursor: string | undefined;
      for (;;) {
        const page = options.state.listVersioned<Json>("service:workflow:", cursor, 25);
        for (const record of page) {
          const candidate = record.value as unknown as Partial<WorkflowRun>;
          if (!candidate || typeof candidate.runId !== "string" || !candidate.runId.startsWith("wf-") ||
              candidate.context?.principal !== options.context.principal || candidate.context?.slotId !== options.context.slotId) continue;
          try {
            const run = await engine.status(options.context, candidate.runId);
            if (!["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"].includes(run.state)) await scheduler.track(run.runId, run.state);
          } catch { discoveryFailures++; }
        }
        if (page.length < 25) break;
        cursor = page.at(-1)!.key;
      }
    } catch (error) { await scheduler.stop({ waitMs: 1000 }).catch(() => undefined); throw error; }
  }
  const view = (run: WorkflowRun) => ({
    runId: run.runId, state: run.state, stateVersion: run.stateVersion, definitionDigest: run.definitionDigest,
    activeStage: run.activeStage, activeSkillRevision: run.activeSkillRevision, usedCalls: run.usedCalls,
    usedIterations: run.usedIterations, createdAt: run.createdAt, deadline: run.deadline,
    output: Buffer.byteLength(JSON.stringify(run.output)) <= 48 * 1024 ? run.output : null,
    outputTruncated: Buffer.byteLength(JSON.stringify(run.output)) > 48 * 1024,
    failureCode: run.failureCode ?? null, handoffs: run.handoffs,
    invocations: run.invocations.slice(-100), events: run.events.slice(-100)
  });
  return {
    async close() { try { return await scheduler?.stop({ waitMs: 5000 }); } finally { closed = true; } },
    async handle(method: string, input: unknown) {
      assertOpen();
      switch (method) {
        case "workflow_scheduler_status": return { autoAdvance: Boolean(scheduler), discoveryFailures, scheduler: await scheduler?.status() ?? null };
        case "workflow_list": return { workflows: catalog.workflows.map(raw => { const d = raw as unknown as WorkflowDefinition; return { workflowId: d.workflowId, revision: d.revision, description: d.description }; }) };
        case "workflow_start": {
          const request = start.parse(input);
          const run = await engine.start({ ...options.context, authority: options.authority, securityMode: "trusted-host" }, {
            workflowId: request.workflowId, revision: request.revision, input: request.input, idempotencyKey: request.idempotencyKey,
            activationSource: { source: "explicit", reason: request.reason }
          });
          await scheduler?.track(run.runId, run.state);
          return view(run);
        }
        case "workflow_resume": {
          const run = await engine.status(options.context, query.parse(input).id);
          if (!scheduler) throw new WorkflowError("SCHEDULER_DISABLED", "Use explicit workflow_tick in manual mode");
          await scheduler.track(run.runId, run.state);
          await scheduler.resume(run.runId);
          return view(run);
        }
        case "workflow_status": return view(await engine.status(options.context, query.parse(input).id));
        case "workflow_tick": return view(await engine.tick(options.context, query.parse(input).id));
        case "workflow_cancel": return view(await engine.cancel(options.context, query.parse(input).id));
        default: throw new WorkflowError("UNKNOWN_METHOD", "Unknown workflow method");
      }
    }
  };
}
