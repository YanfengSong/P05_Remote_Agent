import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ToolApprovalStatus =
  | "pending"
  | "approved"
  | "executing"
  | "denied"
  | "consumed";

export type ToolApprovalRecord = {
  version: 1;
  id: string;
  kind: "tool";
  slot: "A" | "B";
  workspaceId: string;
  workspaceRoot: string;
  capability: string;
  operation: string;
  fingerprint: string;
  inputSummary?: string;
  purpose: string;
  reason: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decisionAt?: string;
  executingAt?: string;
  consumedAt?: string;
};

const APPROVAL_TTL_MS = 15 * 60 * 1000;
const RETENTION_MS = 60 * 60 * 1000;
const RECENT_CONSUMED_REPLAY_GUARD_MS = 5 * 1000;

function approvalDir(stateDir: string): string {
  return path.join(stateDir, "tool-approvals");
}

function recordPath(stateDir: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid approval id.");
  return path.join(approvalDir(stateDir), id + ".json");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

function writeAtomic(target: string, value: ToolApprovalRecord): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + ".tmp-" + process.pid + "-" + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, target);
}

function readRecord(target: string): ToolApprovalRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<ToolApprovalRecord>;
    if (
      value.version !== 1 ||
      value.kind !== "tool" ||
      typeof value.id !== "string" ||
      (value.slot !== "A" && value.slot !== "B") ||
      typeof value.workspaceId !== "string" ||
      typeof value.workspaceRoot !== "string" ||
      typeof value.capability !== "string" ||
      typeof value.operation !== "string" ||
      typeof value.fingerprint !== "string" ||
      (value.inputSummary !== undefined && typeof value.inputSummary !== "string") ||
      typeof value.purpose !== "string" ||
      typeof value.reason !== "string" ||
      !["pending", "approved", "executing", "denied", "consumed"].includes(String(value.status)) ||
      typeof value.requestedAt !== "string" ||
      typeof value.expiresAt !== "string"
    ) {
      return undefined;
    }
    return value as ToolApprovalRecord;
  } catch {
    return undefined;
  }
}

function records(stateDir: string): ToolApprovalRecord[] {
  const dir = approvalDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out: ToolApprovalRecord[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name)) continue;
    const target = path.join(dir, entry.name);
    const record = readRecord(target);
    if (!record) continue;

    const expiry = Date.parse(record.expiresAt);
    const terminalAt = Date.parse(
      record.consumedAt ?? record.decisionAt ?? record.expiresAt
    );
    if (
      (record.status === "consumed" || record.status === "denied" || expiry <= now) &&
      Number.isFinite(terminalAt) &&
      now - terminalAt > RETENTION_MS
    ) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // best-effort cleanup
      }
      continue;
    }
    out.push(record);
  }

  return out.sort(
    (a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)
  );
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

export function toolApprovalFingerprint(input: {
  slot: "A" | "B";
  workspaceId: string;
  workspaceRoot: string;
  capability: string;
  operation: string;
  args: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.slot,
      input.workspaceId.toLowerCase(),
      canonicalPath(input.workspaceRoot),
      input.capability,
      input.operation,
      canonical(input.args)
    ]))
    .digest("hex");
}

export type ToolApprovalGate =
  | { state: "approved"; approvalId: string }
  | {
      state: "executing";
      approvalId: string;
      reason: string;
      purpose: string;
    }
  | {
      state: "recently_consumed";
      approvalId: string;
      reason: string;
      purpose: string;
    }
  | {
      state: "pending";
      approvalId: string;
      reason: string;
      purpose: string;
    }
  | {
      state: "denied";
      approvalId: string;
      reason: string;
      purpose: string;
    };

export function gateToolApproval(
  stateDir: string,
  input: {
    slot: "A" | "B";
    workspaceId: string;
    workspaceRoot: string;
    capability: string;
    operation: string;
    args: unknown;
    inputSummary?: string;
    purpose: string;
    reason: string;
  }
): ToolApprovalGate {
  const fingerprint = toolApprovalFingerprint(input);
  const now = Date.now();
  const matching = records(stateDir).filter(
    (record) => record.fingerprint === fingerprint
  );
  const unexpired = (record: ToolApprovalRecord): boolean =>
    Date.parse(record.expiresAt) > now;

  const approved = matching.find(
    (record) => record.status === "approved" && unexpired(record)
  );
  if (approved) {
    return { state: "approved", approvalId: approved.id };
  }

  const executing = matching.find((record) => record.status === "executing");
  if (executing) {
    return {
      state: "executing",
      approvalId: executing.id,
      reason: executing.reason,
      purpose: executing.purpose
    };
  }

  const denied = matching.find(
    (record) => record.status === "denied" && unexpired(record)
  );
  if (denied) {
    return {
      state: "denied",
      approvalId: denied.id,
      reason: denied.reason,
      purpose: denied.purpose
    };
  }

  const pending = matching.find(
    (record) => record.status === "pending" && unexpired(record)
  );
  if (pending) {
    return {
      state: "pending",
      approvalId: pending.id,
      reason: pending.reason,
      purpose: pending.purpose
    };
  }

  const recentlyConsumed = matching.find((record) => {
    if (record.status !== "consumed" || !record.consumedAt) return false;
    const consumedAt = Date.parse(record.consumedAt);
    return Number.isFinite(consumedAt) &&
      now - consumedAt >= 0 &&
      now - consumedAt <= RECENT_CONSUMED_REPLAY_GUARD_MS;
  });
  if (recentlyConsumed) {
    return {
      state: "recently_consumed",
      approvalId: recentlyConsumed.id,
      reason: recentlyConsumed.reason,
      purpose: recentlyConsumed.purpose
    };
  }

  const id = randomUUID();
  const requestedAt = new Date();
  const created: ToolApprovalRecord = {
    version: 1,
    id,
    kind: "tool",
    slot: input.slot,
    workspaceId: input.workspaceId,
    workspaceRoot: path.resolve(input.workspaceRoot),
    capability: input.capability,
    operation: input.operation,
    fingerprint,
    ...(input.inputSummary ? { inputSummary: input.inputSummary } : {}),
    purpose: input.purpose,
    reason: input.reason,
    status: "pending",
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(
      requestedAt.getTime() + APPROVAL_TTL_MS
    ).toISOString()
  };
  writeAtomic(recordPath(stateDir, id), created);

  return {
    state: "pending",
    approvalId: id,
    reason: input.reason,
    purpose: input.purpose
  };
}

export function beginToolApprovalExecution(
  stateDir: string,
  id: string
): ToolApprovalRecord {
  const target = recordPath(stateDir, id);
  const record = readRecord(target);
  if (!record) throw new Error("Tool approval request not found.");
  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new Error("Tool approval request has expired.");
  }
  if (record.status !== "approved") {
    throw new Error(`Tool approval request is not approved (status=${record.status}).`);
  }

  const executing: ToolApprovalRecord = {
    ...record,
    status: "executing",
    executingAt: new Date().toISOString()
  };
  writeAtomic(target, executing);
  return executing;
}

export function finishToolApprovalExecution(
  stateDir: string,
  id: string
): ToolApprovalRecord {
  const target = recordPath(stateDir, id);
  const record = readRecord(target);
  if (!record) throw new Error("Tool approval request not found.");
  if (record.status === "consumed") return record;
  if (record.status !== "executing") {
    throw new Error(`Tool approval request is not executing (status=${record.status}).`);
  }

  const consumed: ToolApprovalRecord = {
    ...record,
    status: "consumed",
    consumedAt: new Date().toISOString()
  };
  writeAtomic(target, consumed);
  return consumed;
}

export function listToolApprovals(
  stateDir: string,
  slot?: "A" | "B"
): ToolApprovalRecord[] {
  const now = Date.now();
  return records(stateDir).filter(
    (record) =>
      Date.parse(record.expiresAt) > now &&
      record.status !== "consumed" &&
      (!slot || record.slot === slot)
  );
}

export function decideToolApproval(
  stateDir: string,
  id: string,
  decision: "approve" | "deny"
): ToolApprovalRecord {
  const target = recordPath(stateDir, id);
  const record = readRecord(target);
  if (!record) throw new Error("Tool approval request not found.");
  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new Error("Tool approval request has expired.");
  }
  if (record.status !== "pending") {
    throw new Error(`Tool approval request is already ${record.status}.`);
  }

  const next: ToolApprovalRecord = {
    ...record,
    status: decision === "approve" ? "approved" : "denied",
    decisionAt: new Date().toISOString()
  };
  writeAtomic(target, next);
  return next;
}

export type ToolApprovalPublicFields = {
  approvalId: string;
  slot: "A" | "B";
  workspaceId: string;
  capability: string;
  operation: string;
  inputSummary?: string;
  purpose: string;
  reason: string;
};

export type ToolApprovalView = ToolApprovalPublicFields & {
  status: ToolApprovalStatus;
  requestedAt: string;
  expiresAt: string;
};

export function toolApprovalView(
  record: ToolApprovalRecord
): ToolApprovalView {
  return {
    approvalId: record.id,
    slot: record.slot,
    workspaceId: record.workspaceId,
    capability: record.capability,
    operation: record.operation,
    ...(record.inputSummary ? { inputSummary: record.inputSummary } : {}),
    purpose: record.purpose,
    reason: record.reason,
    status: record.status,
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt
  };
}
