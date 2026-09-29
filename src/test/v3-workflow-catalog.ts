import type { SkillDefinition, WorkflowDefinition, RouteDefinition, Schema } from "../v3/workflows/types.js";

/** A deterministic local acceptance workflow with a real approval in the middle. */
export function acceptanceCatalog(workspaceId: string) {
  const text: Schema = { type: "object", properties: { text: { type: "string", maxLength: 4096 } }, required: ["text"], additionalProperties: false };
  const write: Schema = { type: "object", properties: { bytes: { type: "number", minimum: 0 }, sha256: { type: "string", maxLength: 64 } }, required: ["bytes", "sha256"], additionalProperties: false };
  const scope = { workspaceId, authority: ["Read", "WorkspaceWrite"], securityMode: "trusted-host" as const };
  const budget = { maxCalls: 8, maxIterations: 8, maxParallel: 2, timeoutMs: 120000 };
  const stages = ["read", "write", "verify"];
  const skills: SkillDefinition[] = stages.map((stage, index): SkillDefinition => ({
    skillId: stage, revision: "1", description: `Local ${stage} acceptance`, source: "local-test", owner: "local-test", objective: `Complete ${stage}`,
    scope, budget, inputSchema: index === 0 ? { type: "null" } : index === 1 ? text : write,
    outputSchema: index === 1 ? write : text,
    requiredCapabilities: [{ capability: index === 1 ? "fs_write" : "fs_read", version: "1" }], agentRequirements: [],
    body: { id: "action", kind: "capability", capability: index === 1 ? "fs_write" : "fs_read", input: { literal: index === 0 ? { path: "input.txt" } : index === 1 ? { path: "workflow-output.txt", content: "workflow verified\n", expectedSha256: null } : { path: "workflow-output.txt" } } },
    dod: [{ id: "completed", condition: index === 1 ? { op: "gt", left: { ref: "last", path: ["bytes"] }, right: { literal: 0 } } : { op: "eq", left: { ref: "last", path: ["text"] }, right: { literal: index === 0 ? "before\n" : "workflow verified\n" } }, evidence: { ref: "last" } }], stopConditions: []
  }));
  const routes: RouteDefinition[] = stages.slice(0, 2).map((stage, i) => ({ routeId: `route-${i}`, revision: "1", fromStage: stage, toStage: stages[i + 1], targetSkillId: stages[i + 1], targetSkillRevision: "1", reason: "Previous stage verified" }));
  const workflows: WorkflowDefinition[] = [{ workflowId: "local-acceptance", revision: "1", description: "Read, approve write, verify", scope, budget,
    inputSchema: { type: "null" }, outputSchema: text, entryStage: "read",
    stages: stages.map((stage, i) => ({ stageId: stage, skillId: stage, skillRevision: "1", ...(i < 2 ? { next: { routeId: `route-${i}`, revision: "1" } } : {}) })),
    dod: [{ id: "verified-output", condition: { op: "eq", left: { ref: "last", path: ["text"] }, right: { literal: "workflow verified\n" } }, evidence: { ref: "last" } }]
  }];
  return { version: 1, skills, routes, workflows };
}
