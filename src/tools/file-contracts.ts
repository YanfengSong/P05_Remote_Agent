import * as z from "zod/v4";

/** Explicit version marker for the additive file contracts. Legacy calls omit it. */
export const FILE_CONTRACT_VERSION = 2 as const;

export const READ_LIMITS = {
  maxRequests: 20,
  maxPathChars: 1024,
  minLines: 1,
  maxLines: 2000,
  defaultMaxBytes: 64 * 1024,
  minMaxBytes: 4096,
  maxMaxBytes: 256 * 1024,
  /** Server-side hard cap for one raw file snapshot, independent of max_bytes. */
  maxFileBytes: 8 * 1024 * 1024
} as const;

export const PATCH_LIMITS = {
  maxFiles: 20,
  maxEditsPerFile: 100,
  maxPathChars: 1024,
  /** Maximum total candidate content in one write or patch batch. */
  maxCandidateBytes: 1024 * 1024
} as const;

export type TextEdit = {
  old_text: string;
  new_text: string;
};

export type PatchDiffSummary = {
  edits: number;
  bytesBefore: number;
  bytesAfter: number;
  linesBefore: number;
  linesAfter: number;
  preview: string;
};

export type PatchFileResult = {
  path: string;
  ok: boolean;
  bytes: number;
  sha256?: string;
  original_sha256?: string;
  created: boolean;
  applied: boolean;
  diff?: PatchDiffSummary;
  errorCode?: string;
  error?: string;
};

export type PatchBatchStatus =
  | "committed"
  | "dry_run"
  | "rejected"
  | "rolled_back"
  | "unknown"
  | "error";

export type PatchBatchResult = {
  contract_version: typeof FILE_CONTRACT_VERSION;
  status: PatchBatchStatus;
  outcome: Outcome;
  dry_run: boolean;
  files: PatchFileResult[];
  totalBytes: number;
  successCount: number;
  failureCount: number;
  error?: string;
};

export type ReadRequest = {
  path: string;
  offset: number;
  limit: number;
  expected_sha256?: string;
};

export type ReadSlice = {
  path: string;
  sha256: string;
  totalLines: number;
  offset: number;
  returnedLines: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  complete: boolean;
  nextOffset?: number;
};

export type ReadErrorCode =
  | "NOT_FOUND"
  | "NOT_FILE"
  | "IS_DIRECTORY"
  | "ACCESS_DENIED"
  | "PATH_REFUSED"
  | "READ_TOO_LARGE"
  | "READ_LIMIT_INVALID"
  | "READ_UNSTABLE"
  | "INVALID_UTF8"
  | "BINARY_FILE"
  | "STALE_REVISION"
  | "OFFSET_OUT_OF_RANGE"
  | "LINE_TOO_LARGE"
  | "RESULT_BUDGET_TOO_SMALL"
  | "READ_FAILED";

export type Outcome = {
  status: "completed" | "partial" | "rejected" | "conflict" | "error" | "unknown";
  effectState: "none" | "applied" | "rolled_back" | "partial" | "unknown";
  retry: "safe" | "after_refresh" | "never_automatic";
  code: string;
  nextAction: string;
};

export type SearchStopReason =
  | "exhausted"
  | "result_limit"
  | "file_limit"
  | "byte_limit"
  | "io_error";

export type SearchCoverage = {
  complete: boolean;
  stopReason: SearchStopReason;
  scannedFiles: number;
  skippedByReason: Record<string, number>;
};

const OUTCOME_STATUSES = [
  "completed", "partial", "rejected", "conflict", "error", "unknown"
] as const;
const OUTCOME_EFFECT_STATES = [
  "none", "applied", "rolled_back", "partial", "unknown"
] as const;
const OUTCOME_RETRIES = ["safe", "after_refresh", "never_automatic"] as const;

const FIXED_OUTCOMES: Readonly<Record<string, Outcome>> = {
  READ_COMPLETE: {
    status: "completed", effectState: "none", retry: "safe", code: "READ_COMPLETE",
    nextAction: "Use the returned sha256 with a follow-up file request or patch."
  },
  READ_TRUNCATED: {
    status: "partial", effectState: "none", retry: "safe", code: "READ_TRUNCATED",
    nextAction: "Continue with nextOffset or pendingIndexes."
  },
  READ_PARTIAL: {
    status: "partial", effectState: "none", retry: "safe", code: "READ_PARTIAL",
    nextAction: "Retry the failed indexes after correcting the reported error."
  },
  READ_FAILED: {
    status: "error", effectState: "none", retry: "safe", code: "READ_FAILED",
    nextAction: "Correct the request or choose another file."
  },
  LINE_TOO_LARGE: {
    status: "error", effectState: "none", retry: "safe", code: "LINE_TOO_LARGE",
    nextAction: "Request a smaller range or use a dedicated large-file tool."
  },
  RESULT_BUDGET_TOO_SMALL: {
    status: "rejected", effectState: "none", retry: "safe", code: "RESULT_BUDGET_TOO_SMALL",
    nextAction: "Reduce request count or path length, or increase max_bytes."
  },
  STALE_REVISION: {
    status: "conflict", effectState: "none", retry: "after_refresh", code: "STALE_REVISION",
    nextAction: "Re-read the file and rebuild the request."
  },
  DRY_RUN: {
    status: "completed", effectState: "none", retry: "safe", code: "DRY_RUN",
    nextAction: "Review the expected hash and diff, then submit with dry_run=false."
  },
  PATCH_APPLIED: {
    status: "completed", effectState: "applied", retry: "safe", code: "PATCH_APPLIED",
    nextAction: "Use each returned sha256 as the expected_sha256 for the next edit."
  },
  ROLLED_BACK: {
    status: "error", effectState: "rolled_back", retry: "safe", code: "ROLLED_BACK",
    nextAction: "The files were restored; re-read their versions before retrying."
  },
  ROLLBACK_UNCONFIRMED: {
    status: "unknown", effectState: "unknown", retry: "never_automatic",
    code: "ROLLBACK_UNCONFIRMED",
    nextAction: "Inspect the listed files before retrying; do not assume either version is current."
  },
  BATCH_ABORTED: {
    status: "error", effectState: "none", retry: "safe", code: "BATCH_ABORTED",
    nextAction: "Correct the reported batch error and retry."
  },
  WRITE_FAILED: {
    status: "error", effectState: "none", retry: "safe", code: "WRITE_FAILED",
    nextAction: "Correct the reported error and retry."
  },
  SEARCH_COMPLETE: {
    status: "completed", effectState: "none", retry: "safe", code: "SEARCH_COMPLETE",
    nextAction: "No follow-up search is required for the declared scope."
  },
  SEARCH_TRUNCATED: {
    status: "partial", effectState: "none", retry: "safe", code: "SEARCH_TRUNCATED",
    nextAction: "Narrow the path/query scope or raise max_results; the scan limit was reached."
  },
  SEARCH_IO_ERROR: {
    status: "error", effectState: "none", retry: "safe", code: "SEARCH_IO_ERROR",
    nextAction: "Inspect skippedByReason and retry only after resolving the unreadable paths."
  },
  AMBIGUOUS_EDIT: {
    status: "rejected", effectState: "none", retry: "safe", code: "AMBIGUOUS_EDIT",
    nextAction: "Make each old_text occur exactly once, or split the request."
  },
  OVERLAPPING_EDITS: {
    status: "rejected", effectState: "none", retry: "safe", code: "OVERLAPPING_EDITS",
    nextAction: "Remove overlapping edits; each byte range must be disjoint."
  },
  EMPTY_OLD_TEXT: {
    status: "rejected", effectState: "none", retry: "safe", code: "EMPTY_OLD_TEXT",
    nextAction: "Provide non-empty old_text for every edit."
  },
  MISSING_EDIT: {
    status: "rejected", effectState: "none", retry: "safe", code: "MISSING_EDIT",
    nextAction: "Re-read the file and correct old_text."
  },
  INVALID_EDIT: {
    status: "rejected", effectState: "none", retry: "safe", code: "INVALID_EDIT",
    nextAction: "Provide 1-100 valid edits per file."
  },
  DUPLICATE_TARGET: {
    status: "rejected", effectState: "none", retry: "safe", code: "DUPLICATE_TARGET",
    nextAction: "Use each canonical target path once per batch."
  },
  TOO_LARGE: {
    status: "rejected", effectState: "none", retry: "safe", code: "TOO_LARGE",
    nextAction: "Reduce the resulting content below 1 MiB."
  },
  EXPECTED_SHA_REQUIRED: {
    status: "rejected", effectState: "none", retry: "after_refresh", code: "EXPECTED_SHA_REQUIRED",
    nextAction: "Re-read the file and provide expected_sha256."
  },
  TARGET_NOT_FOUND: {
    status: "error", effectState: "none", retry: "after_refresh", code: "TARGET_NOT_FOUND",
    nextAction: "Re-read the file before retrying."
  },
  READ_TOO_LARGE: {
    status: "rejected", effectState: "none", retry: "safe", code: "READ_TOO_LARGE",
    nextAction: "Use a file below the configured read limit."
  },
  SYMLINK_REFUSED: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "SYMLINK_REFUSED",
    nextAction: "Choose a regular workspace file without links."
  },
  HARDLINK_REFUSED: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "HARDLINK_REFUSED",
    nextAction: "Choose a regular workspace file without links."
  },
  NOT_REGULAR_FILE: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "NOT_REGULAR_FILE",
    nextAction: "Choose a regular workspace file."
  },
  NOT_FILE: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "NOT_FILE",
    nextAction: "Choose a regular workspace file."
  },
  INVALID_REQUEST: {
    status: "rejected", effectState: "none", retry: "safe", code: "INVALID_REQUEST",
    nextAction: "Correct the request fields and retry."
  },
  PATH_REFUSED: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "PATH_REFUSED",
    nextAction: "Choose a path inside the active workspace."
  },
  ACCESS_DENIED: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "ACCESS_DENIED",
    nextAction: "Check local permissions before retrying."
  },
  INVALID_UTF8: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "INVALID_UTF8",
    nextAction: "Choose a valid UTF-8 text file."
  },
  BINARY_FILE: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "BINARY_FILE",
    nextAction: "Choose a UTF-8 text file."
  },
  READ_LIMIT_INVALID: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "READ_LIMIT_INVALID",
    nextAction: "Correct the local read limit configuration."
  },
  NOT_FOUND: {
    status: "error", effectState: "none", retry: "after_refresh", code: "NOT_FOUND",
    nextAction: "Re-read the path before retrying."
  },
  IS_DIRECTORY: {
    status: "rejected", effectState: "none", retry: "never_automatic", code: "IS_DIRECTORY",
    nextAction: "Choose a regular file."
  },
  OFFSET_OUT_OF_RANGE: {
    status: "rejected", effectState: "none", retry: "safe", code: "OFFSET_OUT_OF_RANGE",
    nextAction: "Use an offset within totalLines."
  },
  READ_UNSTABLE: {
    status: "error", effectState: "none", retry: "safe", code: "READ_UNSTABLE",
    nextAction: "Re-read the file and retry."
  }
};

/**
 * Fixed outcome mapping shared by reads, patches and searches. Unknown write
 * errors deliberately default to unknown/never_automatic rather than suggesting
 * an automatic retry with an unverified effect.
 */
export function outcomeFor(code: string): Outcome {
  const fixed = FIXED_OUTCOMES[code];
  if (fixed) return { ...fixed };
  return {
    status: "unknown",
    effectState: "unknown",
    retry: "never_automatic",
    code,
    nextAction: "Inspect the result before retrying; the effect is not known."
  };
}

export function isOutcome(value: unknown): value is Outcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (OUTCOME_STATUSES as readonly unknown[]).includes(record.status) &&
    (OUTCOME_EFFECT_STATES as readonly unknown[]).includes(record.effectState) &&
    (OUTCOME_RETRIES as readonly unknown[]).includes(record.retry) &&
    typeof record.code === "string" &&
    typeof record.nextAction === "string"
  );
}

/**
 * A partial read/search that only reports a forward cursor is successful work;
 * every other non-completed outcome is a real failure for MCP and audit purposes.
 */
export function isOutcomeFailure(outcome: Outcome): boolean {
  if (outcome.status === "completed") return false;
  if (
    outcome.status === "partial" &&
    (outcome.code === "READ_TRUNCATED" || outcome.code === "SEARCH_TRUNCATED")
  ) {
    return false;
  }
  return true;
}

/**
 * One returned request item. `error` stays a string so the legacy per-path shape
 * remains valid; V2 adds `errorCode` for machine-readable failures.
 */
export type ReadItem = {
  index: number;
  path: string;
  ok: boolean;
  bytes: number;
  sha256?: string;
  totalLines?: number;
  offset?: number;
  returnedLines?: number;
  lineStart?: number;
  lineEnd?: number;
  text?: string;
  complete?: boolean;
  nextOffset?: number;
  errorCode?: string;
  error?: string;
};

export type ReadBatch = {
  contract_version: typeof FILE_CONTRACT_VERSION;
  outcome: Outcome;
  max_bytes: number;
  files: ReadItem[];
  pendingIndexes: number[];
  totalBytes: number;
  successCount: number;
  failureCount: number;
};

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const readRequestSchema = z.object({
  path: z.string().min(1).max(READ_LIMITS.maxPathChars),
  offset: z.number().int().min(0),
  limit: z.number().int().min(READ_LIMITS.minLines).max(READ_LIMITS.maxLines),
  expected_sha256: sha256Schema.optional()
});

/**
 * Top-level input remains one object, as MCP requires. The legacy `paths` branch and
 * the explicit V2 `requests` branch are mutually exclusive.
 */
export const fsReadManyInputSchema = z.object({
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  paths: z.array(z.string().min(1)).min(1).max(READ_LIMITS.maxRequests).optional(),
  requests: z.array(readRequestSchema).min(1).max(READ_LIMITS.maxRequests).optional(),
  max_bytes: z.number().int().min(READ_LIMITS.minMaxBytes).max(READ_LIMITS.maxMaxBytes).optional()
}).superRefine((value, context) => {
  const hasPaths = value.paths !== undefined;
  const hasRequests = value.requests !== undefined;

  if (hasPaths === hasRequests) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of paths or requests."
    });
    return;
  }

  if (hasRequests) {
    if (value.contract_version !== FILE_CONTRACT_VERSION) {
      context.addIssue({
        code: "custom",
        message: "requests requires contract_version: 2."
      });
    }
    return;
  }

  if (value.contract_version !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Legacy paths must not send contract_version."
    });
  }
  if (value.max_bytes !== undefined) {
    context.addIssue({
      code: "custom",
      message: "max_bytes is only valid with requests."
    });
  }
});

const outcomeSchema = z.object({
  status: z.enum(["completed", "partial", "rejected", "conflict", "error", "unknown"]),
  effectState: z.enum(["none", "applied", "rolled_back", "partial", "unknown"]),
  retry: z.enum(["safe", "after_refresh", "never_automatic"]),
  code: z.string(),
  nextAction: z.string()
});

export const textEditSchema = z.object({
  old_text: z.string().min(1),
  new_text: z.string()
});

/**
 * `apply_patch_many` keeps the legacy old_text/new_text shape and adds an explicit
 * V2 shape with per-file edit lists and dry_run. The V2 branch is selected only by
 * `contract_version: 2`.
 */
export const applyPatchManyInputSchema = z.object({
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  dry_run: z.boolean().optional(),
  patches: z.array(z.object({
    path: z.string().min(1),
    expected_sha256: sha256Schema,
    old_text: z.string().min(1).optional(),
    new_text: z.string().optional(),
    edits: z.array(textEditSchema).min(1).max(PATCH_LIMITS.maxEditsPerFile).optional()
  })).min(1).max(PATCH_LIMITS.maxFiles)
}).superRefine((value, context) => {
  if (value.contract_version === FILE_CONTRACT_VERSION) {
    for (const [index, patch] of value.patches.entries()) {
      if (patch.edits === undefined) {
        context.addIssue({
          code: "custom",
          path: ["patches", index, "edits"],
          message: "V2 patches require edits."
        });
      }
      if (patch.old_text !== undefined || patch.new_text !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["patches", index],
          message: "V2 patches must use edits, not old_text/new_text."
        });
      }
      if (patch.path.length > PATCH_LIMITS.maxPathChars) {
        context.addIssue({
          code: "custom",
          path: ["patches", index, "path"],
          message: "V2 patch paths must not exceed " + PATCH_LIMITS.maxPathChars + " characters."
        });
      }
    }
    return;
  }

  if (value.dry_run !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["dry_run"],
      message: "dry_run is only valid with contract_version: 2."
    });
  }
  for (const [index, patch] of value.patches.entries()) {
    if (patch.old_text === undefined || patch.new_text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["patches", index],
        message: "Legacy patches require old_text and new_text."
      });
    }
    if (patch.edits !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["patches", index, "edits"],
        message: "Legacy patches must not use edits."
      });
    }
  }
});

const patchDiffSchema = z.object({
  edits: z.number().int().positive(),
  bytesBefore: z.number().int().nonnegative(),
  bytesAfter: z.number().int().nonnegative(),
  linesBefore: z.number().int().nonnegative(),
  linesAfter: z.number().int().nonnegative(),
  preview: z.string()
});

const patchFileResultSchema = z.object({
  path: z.string(),
  ok: z.boolean().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema.optional(),
  original_sha256: sha256Schema.optional(),
  created: z.boolean(),
  applied: z.boolean().optional(),
  diff: patchDiffSchema.optional(),
  errorCode: z.string().optional(),
  error: z.string().optional()
});

/** One schema accepts the unchanged legacy result and the richer V2 result. */
export const applyPatchManyOutputSchema = z.object({
  status: z.enum(["committed", "dry_run", "rejected", "rolled_back", "unknown", "error"]),
  files: z.array(patchFileResultSchema),
  totalBytes: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative().optional(),
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  dry_run: z.boolean().optional(),
  outcome: outcomeSchema.optional(),
  error: z.string().optional()
});

export const searchCoverageSchema = z.object({
  complete: z.boolean(),
  stopReason: z.enum(["exhausted", "result_limit", "file_limit", "byte_limit", "io_error"]),
  scannedFiles: z.number().int().nonnegative(),
  skippedByReason: z.record(z.string(), z.number().int().nonnegative())
});

export const fsSearchInputSchema = z.object({
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  query: z.string().min(1).max(500),
  path: z.string().min(1).optional(),
  case_sensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).max(100).optional()
});

const searchMatchSchema = z.object({
  line: z.number().int().positive(),
  occurrences: z.number().int().positive(),
  snippet: z.string()
});

const searchFileResultSchema = z.object({
  path: z.string(),
  matchCount: z.number().int().nonnegative(),
  matches: z.array(searchMatchSchema),
  matchesTruncated: z.boolean()
});

/** Legacy fields stay unchanged; V2 adds coverage, outcome and the version marker. */
export const fsSearchOutputSchema = z.object({
  query: z.string(),
  root: z.string(),
  scannedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  totalBytesScanned: z.number().int().nonnegative(),
  matchCount: z.number().int().nonnegative(),
  matchedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  results: z.array(searchFileResultSchema),
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  coverage: searchCoverageSchema.optional(),
  outcome: outcomeSchema.optional()
});

const readItemSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  path: z.string(),
  ok: z.boolean(),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema.optional(),
  totalLines: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  returnedLines: z.number().int().nonnegative().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  complete: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional()
});

/** One schema accepts both the unchanged legacy result and the richer V2 result. */
export const fsReadManyOutputSchema = z.object({
  files: z.array(readItemSchema),
  totalBytes: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  contract_version: z.literal(FILE_CONTRACT_VERSION).optional(),
  outcome: outcomeSchema.optional(),
  max_bytes: z.number().int().positive().optional(),
  pendingIndexes: z.array(z.number().int().nonnegative()).optional()
});
