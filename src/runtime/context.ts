import { randomUUID } from "node:crypto";
import type { ToolProfile } from "../capability/types.js";
import type { WorkspaceDescriptor } from "../workspace/types.js";

export const ACTOR_TYPES = ["interactive", "agent", "plugin", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type ExecutionActor = {
  type: ActorType;
  id: string;
};

export type ExecutionIsolation = {
  kind: "workspace" | "worktree" | "session-root";
  root: string;
  sourceWorkspaceId: string;
};

export type ExecutionAuthority = {
  profile: ToolProfile;
  approvalState?: "not-required" | "required" | "approved" | "denied";
};

export type ExecutionContext = {
  executionId: string;
  workspaceId: string;
  workspaceRoot: string;
  actor: ExecutionActor;
  sessionId?: string;
  taskId?: string;
  isolation?: ExecutionIsolation;
  authority: ExecutionAuthority;
  capturedAt: string;
};

export function createExecutionContext(args: {
  workspace: Pick<WorkspaceDescriptor, "id" | "root">;
  actor: ExecutionActor;
  profile: ToolProfile;
  executionId?: string;
  sessionId?: string;
  taskId?: string;
  isolation?: ExecutionIsolation;
  approvalState?: ExecutionAuthority["approvalState"];
}): ExecutionContext {
  return Object.freeze({
    executionId: args.executionId ?? randomUUID(),
    workspaceId: args.workspace.id,
    workspaceRoot: args.workspace.root,
    actor: Object.freeze({ ...args.actor }),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.isolation
      ? { isolation: Object.freeze({ ...args.isolation }) }
      : {}),
    authority: Object.freeze({
      profile: args.profile,
      ...(args.approvalState ? { approvalState: args.approvalState } : {})
    }),
    capturedAt: new Date().toISOString()
  });
}

export function withSession(
  context: ExecutionContext,
  sessionId: string
): ExecutionContext {
  return createExecutionContext({
    workspace: { id: context.workspaceId, root: context.workspaceRoot },
    actor: context.actor,
    profile: context.authority.profile,
    executionId: context.executionId,
    sessionId,
    taskId: context.taskId,
    isolation: context.isolation,
    approvalState: context.authority.approvalState
  });
}
