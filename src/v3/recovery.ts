import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import { readV3Config } from "./config.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";
import { startV3Application } from "./application.js";

const ownerSchema = z.object({
  hostId: z.string().uuid(), slotId: z.enum(["A", "B"]), coreInstanceId: z.string().uuid(),
  instanceGeneration: z.number().int().positive(), state: z.enum(["active", "released"]),
  startedAt: z.string().datetime(), releasedAt: z.string().datetime().optional()
}).strict();
export type RecoveryOwner = z.infer<typeof ownerSchema>;
export interface RecoveryInspection {
  code: "STATE_NOT_FOUND" | "SLOT_NOT_INITIALIZED" | "OWNER_RECORDED";
  slotId: string;
  owner: RecoveryOwner | null;
  /** A persisted active record is not evidence that a process is currently alive. */
  liveness: "unverified";
}
export class RecoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RecoveryError"; }
}
function within(root: string, target: string): boolean {
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalized(root), normalized(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
async function trustedConfiguration(filename: string) {
  const canonical = fs.realpathSync(path.resolve(filename));
  if (!(await verifyStateProtection(path.dirname(canonical))).verified || !(await verifyConfigurationProtection(canonical)).verified) throw new RecoveryError("RECOVERY_CONFIGURATION_UNPROTECTED");
  return { filename: canonical, config: readV3Config(canonical) };
}

/** Local inspection only: never creates state, modifies owner records, or steals the ownership lock. */
export async function inspectV3Recovery(filename: string): Promise<RecoveryInspection> {
  const { config } = await trustedConfiguration(filename);
  const empty = (code: "STATE_NOT_FOUND" | "SLOT_NOT_INITIALIZED"): RecoveryInspection => ({ code, slotId: config.slotId, owner: null, liveness: "unverified" });
  if (!fs.existsSync(config.stateDir)) return empty("STATE_NOT_FOUND");
  const state = fs.realpathSync(config.stateDir);
  if (within(state, config.workspaceRoot) || within(config.workspaceRoot, state)) throw new RecoveryError("STATE_WORKSPACE_OVERLAP");
  if (!(await verifyStateProtection(state)).verified) throw new RecoveryError("RECOVERY_STATE_UNPROTECTED");
  const databaseFile = path.join(state, "slots", config.slotId.toLowerCase(), "core.sqlite");
  if (!fs.existsSync(databaseFile)) return empty("SLOT_NOT_INITIALIZED");
  const actual = fs.realpathSync(databaseFile);
  if (!within(state, actual) || actual !== databaseFile || !(await verifyConfigurationProtection(actual)).verified) throw new RecoveryError("RECOVERY_DATABASE_UNPROTECTED");
  const database = new DatabaseSync(actual, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    const row = database.prepare("SELECT value FROM core_state WHERE key='owner'").get() as { value: string } | undefined;
    if (!row) throw new RecoveryError("RECOVERY_OWNER_MISSING");
    if (typeof row.value !== "string" || Buffer.byteLength(row.value) > 8192) throw new RecoveryError("RECOVERY_OWNER_INVALID");
    const owner = ownerSchema.parse(JSON.parse(row.value));
    if (owner.slotId !== config.slotId) throw new RecoveryError("RECOVERY_OWNER_INVALID");
    return { code: "OWNER_RECORDED", slotId: config.slotId, owner, liveness: "unverified" };
  } finally { database.close(); }
}

/** The caller must be a local operator, never an MCP or private RPC method. */
export async function resumeV3Recovery(filename: string, expectedOwnerId: string, reason: string) {
  if (!z.string().uuid().safeParse(expectedOwnerId).success || !reason.trim() || reason.length > 1024 || /[\x00-\x1f\x7f]/.test(reason)) throw new RecoveryError("RECOVERY_ACKNOWLEDGEMENT_INVALID");
  const inspected = await inspectV3Recovery(filename);
  if (!inspected.owner) throw new RecoveryError(inspected.code);
  if (inspected.owner.coreInstanceId !== expectedOwnerId) throw new RecoveryError("RECOVERY_OWNER_MISMATCH");
  if (inspected.owner.state !== "active") throw new RecoveryError("RECOVERY_NOT_REQUIRED");
  // The application revalidates config and acquires the original exclusive lock.
  // A live Core still wins the lock, and a changed owner cannot be acknowledged by this ID.
  return startV3Application(fs.realpathSync(filename), { recoverUncleanOwner: { coreInstanceId: expectedOwnerId, reason: reason.trim() } });
}
