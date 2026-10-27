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
