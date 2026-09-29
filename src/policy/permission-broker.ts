import path from "node:path";
import type { CapabilityCatalog } from "../capability/registry.js";
import {
  beginToolApprovalExecution,
  finishToolApprovalExecution,
  gateToolApproval,
  type ToolApprovalGate,
  type ToolApprovalPublicFields
} from "../approval/tool-approval.js";
import { preflightShellExecution } from "../shell/preflight.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { permissionDecision } from "./permission.js";

export type PermissionAuthorization =
  | {
      state: "allowed";
      decision: "allow";
      operation: string;
      approvalId?: string;
    }
  | ({
      state: "approval_required";
      decision: "confirm";
    } & ToolApprovalPublicFields)
  | ({
      state: "approval_denied";
      decision: "confirm";
    } & ToolApprovalPublicFields)
  | ({
      state: "approval_in_progress";
      decision: "confirm";
    } & ToolApprovalPublicFields)
  | ({
      state: "approval_recently_consumed";
      decision: "confirm";
    } & ToolApprovalPublicFields)
  | {
      state: "denied";
      decision: "deny";
      operation: string;
      purpose: string;
      reason: string;
    };

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function approvalFingerprintArgs(
  capability: string,
  args: unknown,
  workspaceRoot: string
): unknown {
  if (
    capability !== "shell_run" ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    return args;
  }

  const input = args as Record<string, unknown>;
  const command =
    typeof input.command === "string" ? input.command.trim() : "";
  const explicitCwd =
    typeof input.cwd === "string" && input.cwd.trim()
      ? canonicalPath(path.resolve(workspaceRoot, input.cwd.trim()))
      : undefined;

  // timeoutMs affects transport waiting only. The implicit cwd is already
  // represented by workspaceRoot in the outer fingerprint, so omit it here;
  // this also avoids path-casing noise across Windows MCP invocations.
  return explicitCwd ? { command, cwd: explicitCwd } : { command };
}

export class ToolPermissionBroker {
  constructor(
    private readonly options: {
      stateDir: string;
      runtimeSlot?: "A" | "B";
      workspaceManager: WorkspaceManager;
      capabilityCatalog: CapabilityCatalog;
    }
  ) {}

  async authorize(
    capability: string,
    args: unknown
  ): Promise<PermissionAuthorization> {
    const workspace = this.options.workspaceManager.current();
    const workspaceRoot = this.options.workspaceManager.currentRoot();
    const decision = await permissionDecision(
      capability,
      args,
      this.options.capabilityCatalog,
      workspaceRoot
    );

    if (decision.mode === "allow") {
      return {
        state: "allowed",
        decision: "allow",
        operation: decision.operation
      };
    }

    if (decision.mode === "deny") {
      return {
        state: "denied",
        decision: "deny",
        operation: decision.operation,
        purpose: decision.purpose,
        reason: decision.reason
      };
    }

    const runtimeSlot = this.options.runtimeSlot;
    if (!runtimeSlot) {
      return {
        state: "denied",
        decision: "deny",
        operation: decision.operation,
        purpose: decision.purpose,
        reason:
          "confirmation requires an explicit Runtime slot identity (A or B)"
      };
    }

    const gate: ToolApprovalGate = gateToolApproval(
      this.options.stateDir,
      {
        slot: runtimeSlot,
        workspaceId: workspace.id,
        workspaceRoot,
        capability,
        operation: decision.operation,
        args: approvalFingerprintArgs(capability, args, workspaceRoot),
        ...(decision.inputSummary
          ? { inputSummary: decision.inputSummary }
          : {}),
        purpose: decision.purpose,
        reason: decision.reason
      }
    );

    if (gate.state === "approved") {
      return {
        state: "allowed",
        decision: "allow",
        operation: decision.operation,
        approvalId: gate.approvalId
      };
    }

    const common = {
      approvalId: gate.approvalId,
      slot: runtimeSlot,
      workspaceId: workspace.id,
      capability,
      operation: decision.operation,
      ...(decision.inputSummary ? { inputSummary: decision.inputSummary } : {}),
      purpose: gate.purpose,
      reason: gate.reason
    };

    if (gate.state === "denied") {
      return {
        state: "approval_denied",
        decision: "confirm",
        ...common
      };
    }

    if (gate.state === "executing") {
      return {
        state: "approval_in_progress",
        decision: "confirm",
        ...common
      };
    }

    if (gate.state === "recently_consumed") {
      return {
        state: "approval_recently_consumed",
        decision: "confirm",
        ...common
      };
    }

    return {
      state: "approval_required",
      decision: "confirm",
      ...common
    };
  }

  async preflight(capability: string, args: unknown): Promise<void> {
    if (
      capability !== "shell_run" ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    ) {
      return;
    }

    const input = args as Record<string, unknown>;
    const command =
      typeof input.command === "string" ? input.command : "";
    const cwd =
      typeof input.cwd === "string" && input.cwd.trim()
        ? input.cwd
        : undefined;

    await preflightShellExecution(
      command,
      this.options.workspaceManager.currentRoot(),
      cwd
    );
  }

  beginApprovalExecution(approvalId: string): void {
    beginToolApprovalExecution(this.options.stateDir, approvalId);
  }

  finishApprovalExecution(approvalId: string): void {
    finishToolApprovalExecution(this.options.stateDir, approvalId);
  }
}

export function permissionErrorMessage(
  capability: string,
  authorization: Exclude<
    PermissionAuthorization,
    { state: "allowed" }
  >
): string {
  if (authorization.state === "denied") {
    return [
      "PERMISSION_DENIED",
      `capability: ${capability}`,
      `operation: ${authorization.operation}`,
      `purpose: ${authorization.purpose}`,
      `reason: ${authorization.reason}`
    ].join("\n");
  }

  const header =
    authorization.state === "approval_required"
      ? "PERMISSION_CONFIRM_REQUIRED"
      : authorization.state === "approval_denied"
        ? "PERMISSION_CONFIRM_DENIED"
        : authorization.state === "approval_in_progress"
          ? "PERMISSION_CONFIRM_IN_PROGRESS"
          : "PERMISSION_CONFIRM_ALREADY_USED";

  const guidance =
    authorization.state === "approval_required"
      ? "Approve this request in the Local Operator. Compatible clients may resume it automatically; otherwise retry the same tool call once."
      : authorization.state === "approval_in_progress"
        ? "An identical approved call is already executing. Do not create or approve a duplicate request; inspect the original call instead."
        : authorization.state === "approval_recently_consumed"
          ? "An identical approved call completed moments ago. Do not retry automatically; issue a new call only if re-execution is intentionally required."
          : undefined;

  return [
    header,
    `approvalId: ${authorization.approvalId}`,
    `slot: ${authorization.slot}`,
    `workspaceId: ${authorization.workspaceId}`,
    `capability: ${authorization.capability}`,
    `operation: ${authorization.operation}`,
    ...(authorization.inputSummary ? [`inputSummary: ${authorization.inputSummary}`] : []),
    `purpose: ${authorization.purpose}`,
    `reason: ${authorization.reason}`,
    ...(guidance ? [guidance] : [])
  ].join("\n");
}
