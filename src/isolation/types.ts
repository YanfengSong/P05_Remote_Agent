import type { ActorType, ExecutionContext } from "../runtime/context.js";

export const ISOLATION_MODES = ["workspace", "worktree"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const ISOLATION_STATES = ["active", "released", "broken"] as const;
export type IsolationState = (typeof ISOLATION_STATES)[number];

export type IsolationRecord = {
  id: string;
  workspaceId: string;
  ownerActorType: ActorType;
  ownerActorId: string;
  mode: IsolationMode;
  state: IsolationState;
  baseCommit?: string;
  reconciledCommit?: string;
  createdAt: string;
  lastCheckedAt: string;
  releasedAt?: string;
};

export type IsolationView = IsolationRecord & {
  root: string;
  currentCommit?: string;
  dirty?: boolean;
};

export type ReconcilePlan = {
  isolationId: string;
  workspaceId: string;
  baseCommit: string;
  currentCommit: string;
  commits: string[];
  dirty: boolean;
  ready: boolean;
};

export type IsolationAllocation = {
  context: ExecutionContext;
  isolation: IsolationView;
};
