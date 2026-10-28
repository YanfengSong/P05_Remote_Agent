import fs from "node:fs/promises";
import path from "node:path";

export type TraceEvent = {
  callId: number;
  tool: string;
  target?: string;
  expectedSha256?: string;
  observedCode?: string;
  refreshedSha256?: string;
  conflict?: boolean;
};

export type TraceMetrics = {
  conflicts: number;
  unsafeRetries: number;
  unattributedConflicts: number;
};

function targetKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve a target to a stable trace key, resolving the nearest existing
 * ancestor so aliases and not-yet-created files share identity.
 */
export async function canonicalTraceTarget(
  root: string,
  target: string
): Promise<string> {
  const resolved = path.resolve(root, target);
  try {
    return targetKey(await fs.realpath(resolved));
  } catch {
    // Missing file: resolve the parent and append the basename.
  }
  try {
    const parent = await fs.realpath(path.dirname(resolved));
    return targetKey(path.join(parent, path.basename(resolved)));
  } catch {
    return targetKey(resolved);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build per-target trace events from one real apply_patch_many response.
 * A top-level conflict is never copied to every target; only files whose own
 * errorCode is STALE_REVISION are attributed. If per-target diagnostics are
 * absent, one call-level event is emitted and counted as unattributed.
 */
export function patchTraceEvents(input: {
  callId: number;
  tool: "apply_patch_many";
  patches: readonly unknown[];
  files?: readonly unknown[];
  topLevelCode?: string;
  topLevelConflict?: boolean;
}): TraceEvent[] {
  const fileEntries = Array.isArray(input.files)
    ? input.files.filter(isRecord)
    : [];
  const byPath = new Map<string, Record<string, unknown>>();
  for (const file of fileEntries) {
    if (typeof file.path === "string") byPath.set(file.path, file);
  }

  const events: TraceEvent[] = [];
  for (const patch of input.patches) {
    if (!isRecord(patch) || typeof patch.path !== "string") continue;
    const target = patch.path;
    const expectedSha256 = typeof patch.expected_sha256 === "string"
      ? patch.expected_sha256
      : undefined;
    const file = byPath.get(target);
    const observedCode = file
      ? typeof file.errorCode === "string"
        ? file.errorCode
        : file.ok === true
          ? "OK"
          : undefined
      : undefined;
    events.push({
      callId: input.callId,
      tool: input.tool,
      target,
      ...(expectedSha256 ? { expectedSha256 } : {}),
      ...(observedCode ? { observedCode } : {}),
      ...(observedCode === "STALE_REVISION" ? { conflict: true } : {})
    });
  }

  const attributed = events.some((event) => event.conflict === true);
  if (input.topLevelConflict && !attributed) {
    events.push({
      callId: input.callId,
      tool: input.tool,
      ...(input.topLevelCode ? { observedCode: input.topLevelCode } : {}),
      conflict: true
    });
  }
  return events;
}

/** Build refresh events from one real fs_read_many response. */
export function readTraceEvents(input: {
  callId: number;
  tool: "fs_read_many";
  files: readonly unknown[];
}): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const file of input.files) {
    if (!isRecord(file)) continue;
    if (file.ok !== true) continue;
    if (typeof file.path !== "string" || typeof file.sha256 !== "string") continue;
    events.push({
      callId: input.callId,
      tool: input.tool,
      target: file.path,
      refreshedSha256: file.sha256
    });
  }
  return events;
}

/**
 * Count conflicts and dangerous retries per target and expected hash.
 *
 * A dangerous retry is a patch request that reuses a hash after that target's
 * conflict, unless the target was read again after the conflict and the read
 * returned that same hash. The latter is an informed retry, not a blind one.
 * Conflict counts include call-level conflicts that cannot be attributed to a
 * target, exposed separately as unattributedConflicts.
 */
export function metricsFor(trace: readonly TraceEvent[]): TraceMetrics {
  const staleByTarget = new Map<string, Set<string>>();
  const refreshedAfterConflict = new Map<string, string | undefined>();
  let conflicts = 0;
  let unsafeRetries = 0;
  let unattributedConflicts = 0;

  for (const event of trace) {
    const target = event.target ? targetKey(event.target) : undefined;
    const patchTool = event.tool === "apply_patch" || event.tool === "apply_patch_many";

    if (event.refreshedSha256 !== undefined) {
      if (target && refreshedAfterConflict.has(target)) {
        refreshedAfterConflict.set(target, event.refreshedSha256);
      }
      continue;
    }

    if (patchTool && target && event.expectedSha256) {
      const stale = staleByTarget.get(target);
      if (stale?.has(event.expectedSha256)) {
        const lastRead = refreshedAfterConflict.get(target);
        if (lastRead !== event.expectedSha256) unsafeRetries += 1;
      }
    }

    if (event.conflict === true || event.observedCode === "STALE_REVISION") {
      conflicts += 1;
      if (!target) {
        unattributedConflicts += 1;
        continue;
      }
      const stale = staleByTarget.get(target) ?? new Set<string>();
      if (event.expectedSha256) stale.add(event.expectedSha256);
      staleByTarget.set(target, stale);
      // Reads before this conflict do not make a later reuse informed.
      refreshedAfterConflict.set(target, undefined);
    }
  }

  return { conflicts, unsafeRetries, unattributedConflicts };
}
