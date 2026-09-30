import fs from "node:fs";
import path from "node:path";
import { defaultP05StateDir } from "../state.js";

export type ApprovalMode = "standard" | "trusted";

export type ApprovalModeState = {
  mode: ApprovalMode;
  source: "state" | "env" | "default";
  updatedAt?: string;
};

function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "standard" || normalized === "trusted"
    ? normalized
    : undefined;
}

export function approvalModeStatePath(): string {
  const override = process.env.P05_APPROVAL_MODE_STATE_FILE?.trim();
  return override
    ? path.resolve(override)
    : path.join(defaultP05StateDir(), "approval-mode.json");
}

export function readApprovalMode(): ApprovalModeState {
  const target = approvalModeStatePath();
  try {
    const raw = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      updatedAt?: unknown;
    };
    const mode = parseApprovalMode(parsed.mode);
    if (mode) {
      return {
        mode,
        source: "state",
        ...(typeof parsed.updatedAt === "string"
          ? { updatedAt: parsed.updatedAt }
          : {})
      };
    }
  } catch {
    // Missing or malformed local state falls back to the configured default.
  }

  const fromEnv = parseApprovalMode(process.env.P05_APPROVAL_MODE);
  if (fromEnv) return { mode: fromEnv, source: "env" };
  return { mode: "standard", source: "default" };
}

export function writeApprovalMode(mode: ApprovalMode): ApprovalModeState {
  const target = approvalModeStatePath();
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });

  const state = {
    mode,
    updatedAt: new Date().toISOString()
  };
  const temp = target + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.rmSync(target, { force: true });
  fs.renameSync(temp, target);

  return {
    mode,
    source: "state",
    updatedAt: state.updatedAt
  };
}

export function trustedApprovalModeEnabled(): boolean {
  return readApprovalMode().mode === "trusted";
}
