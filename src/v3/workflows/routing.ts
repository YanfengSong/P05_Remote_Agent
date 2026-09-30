import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { WorkflowError, type Activation, type WorkflowContext } from "./types.js";
import { WorkflowRegistry } from "./registry.js";

const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
export const activationRouteSchema = z.object({
  routeId: token,
  kind: z.enum(["alias", "intent"]),
  value: token,
  workflowId: token,
  revision: token,
  reason: z.string().min(1).max(4096),
  majorBehaviorChange: z.boolean().default(false)
}).strict();

export const projectRuleSchema = z.object({
  ruleId: token,
  workspaceId: token,
  securityMode: z.enum(["trusted-host", "constrained-host", "isolated-worker"]).optional(),
  allowedWorkflows: z.array(token).max(128).optional(),
  deniedWorkflows: z.array(token).max(128).default([]),
  authorityCeiling: z.array(token).max(32).optional()
}).strict();

export type ActivationRoute = z.infer<typeof activationRouteSchema>;
export type ProjectRule = z.infer<typeof projectRuleSchema>;
export type ActivationRoutingRequest = {
  explicit?: { workflowId: string; revision: string };
  explicitAlias?: string;
  workflowHandoff?: { workflowId: string; revision: string; reason: string };
  intentSignals?: string[];
  untrustedText?: string;
};
export type ActivationRoutingResult = {
  workflowId: string;
  revision: string;
  activation: Activation;
  routeId: string | null;
  projectRuleIds: string[];
  untrustedTextDigest: string | null;
};

const targetKey = (value: { workflowId: string; revision: string }) => value.workflowId + "@" + value.revision;

export class SkillActivationRouter {
  private readonly routes: ActivationRoute[];
  private readonly rules: ProjectRule[];
  constructor(private readonly registry: WorkflowRegistry, routes: unknown[], rules: unknown[]) {
    this.routes = routes.map(route => activationRouteSchema.parse(route));
    this.rules = rules.map(rule => projectRuleSchema.parse(rule));
    const routeIds = new Set<string>();
    for (const route of this.routes) {
      if (routeIds.has(route.routeId)) throw new WorkflowError("DUPLICATE_ACTIVATION_ROUTE", "Activation route IDs must be unique");
      routeIds.add(route.routeId);
      this.registry.snapshot(route.workflowId, route.revision);
    }
    const ruleIds = new Set<string>();
    for (const rule of this.rules) {
      if (ruleIds.has(rule.ruleId)) throw new WorkflowError("DUPLICATE_PROJECT_RULE", "Project rule IDs must be unique");
      ruleIds.add(rule.ruleId);
    }
  }

  route(context: WorkflowContext, request: ActivationRoutingRequest): ActivationRoutingResult {
    if (request.untrustedText !== undefined && (typeof request.untrustedText !== "string" || request.untrustedText.length > 64 * 1024)) {
      throw new WorkflowError("INVALID_UNTRUSTED_TEXT", "Untrusted routing evidence is bounded text only");
    }
    const explicitCandidates: { workflowId: string; revision: string; routeId: string | null; reason: string }[] = [];
    if (request.explicit) explicitCandidates.push({ ...request.explicit, routeId: null, reason: "Explicit workflow selection" });
    if (request.explicitAlias) {
      for (const route of this.routes.filter(item => item.kind === "alias" && item.value === request.explicitAlias)) {
        explicitCandidates.push({ workflowId: route.workflowId, revision: route.revision, routeId: route.routeId, reason: route.reason });
      }
      if (!explicitCandidates.length) throw new WorkflowError("ROUTE_NOT_FOUND", "Explicit alias is not registered");
    }

    let source: Activation["source"];
    let selected: { workflowId: string; revision: string; routeId: string | null; reason: string };
    if (explicitCandidates.length) {
      selected = this.unique(explicitCandidates);
      source = "explicit";
    } else if (request.workflowHandoff) {
      selected = { ...request.workflowHandoff, routeId: null };
      source = "workflow-handoff";
    } else {
      const signals = [...new Set(request.intentSignals ?? [])];
      const candidates = this.routes
        .filter(route => route.kind === "intent" && signals.includes(route.value) && !route.majorBehaviorChange)
        .map(route => ({ workflowId: route.workflowId, revision: route.revision, routeId: route.routeId, reason: route.reason }));
      if (!candidates.length) {
        const major = this.routes.some(route => route.kind === "intent" && signals.includes(route.value) && route.majorBehaviorChange);
        throw new WorkflowError(major ? "EXPLICIT_ACTIVATION_REQUIRED" : "ROUTE_NOT_FOUND", major ? "Major behavior change requires explicit activation" : "No evidence-backed activation route matched");
      }
      selected = this.unique(candidates);
      source = "intent-match";
    }

    const snapshot = this.registry.snapshot(selected.workflowId, selected.revision);
    const workflow = snapshot.workflow;
    if (workflow.scope.workspaceId !== context.workspaceId || workflow.scope.securityMode !== context.securityMode ||
        !workflow.scope.authority.every(authority => context.authority.includes(authority))) {
      throw new WorkflowError("ROUTING_SCOPE_CONFLICT", "Selected workflow exceeds the caller scope");
    }

    const applicable = this.rules.filter(rule => rule.workspaceId === context.workspaceId && (!rule.securityMode || rule.securityMode === context.securityMode));
    for (const rule of applicable) {
      if (rule.allowedWorkflows && !rule.allowedWorkflows.includes(workflow.workflowId)) {
        throw new WorkflowError("PROJECT_RULE_CONFLICT", "Project rule does not allow the selected workflow");
      }
      if (rule.deniedWorkflows.includes(workflow.workflowId)) {
        throw new WorkflowError("PROJECT_RULE_CONFLICT", "Project rule denies the selected workflow");
      }
      if (rule.authorityCeiling && !workflow.scope.authority.every(authority => rule.authorityCeiling!.includes(authority))) {
        throw new WorkflowError("PROJECT_RULE_CONFLICT", "Project rule authority ceiling rejects the selected workflow");
      }
    }

    return {
      workflowId: selected.workflowId,
      revision: selected.revision,
      activation: { source, reason: selected.reason },
      routeId: selected.routeId,
      projectRuleIds: applicable.map(rule => rule.ruleId),
      untrustedTextDigest: request.untrustedText === undefined ? null : createHash("sha256").update(request.untrustedText).digest("hex")
    };
  }

  private unique(candidates: { workflowId: string; revision: string; routeId: string | null; reason: string }[]) {
    const targets = new Set(candidates.map(targetKey));
    if (targets.size !== 1) throw new WorkflowError("ROUTING_CONFLICT", "Equal-precedence activation candidates disagree");
    return candidates[0]!;
  }
}