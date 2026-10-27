import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { listDirectory, patchTextFile, patchTextFilesBatch, patchTextFilesBatchV2, readTextFile, searchTextFiles, searchTextFilesV2, writeTextFile, writeTextFilesBatch } from "./files.js";
import { applyPatchManyInputSchema, applyPatchManyOutputSchema, fsReadManyInputSchema, fsReadManyOutputSchema, fsSearchInputSchema, fsSearchOutputSchema, isOutcomeFailure, READ_LIMITS, type PatchBatchResult } from "./file-contracts.js";
import { readManyRanges } from "./read-ranges.js";
import { structuredResult } from "./result.js";
import { assertWorkspaceWriteTarget } from "./write-target.js";

function renderPatchBatchContent(result: PatchBatchResult): string {
  const parts: string[] = [
    "V2 apply_patch_many: " +
      result.status +
      " (" +
      result.outcome.code +
      "), dry_run=" +
      result.dry_run +
      ", files=" +
      result.files.length +
      "."
  ];

  for (const file of result.files) {
    if (file.ok) {
      parts.push(
        "--- " +
          file.path +
          " | " +
          (result.dry_run ? "expected_sha256=" : "sha256=") +
          file.sha256 +
          " | bytes=" +
          file.bytes +
          " | applied=" +
          file.applied +
          " ---"
      );
      if (file.diff) {
        parts.push(
          "diff: " +
            file.diff.edits +
            " edit(s), lines " +
            file.diff.linesBefore +
            " -> " +
            file.diff.linesAfter +
            ", bytes " +
            file.diff.bytesBefore +
            " -> " +
            file.diff.bytesAfter
        );
        parts.push(file.diff.preview);
      }
    } else {
      parts.push(
        "--- " + file.path + " | ERROR " + (file.errorCode ?? "WRITE_FAILED") + " ---"
      );
      parts.push(file.error ?? "Could not apply the patch.");
    }
  }

  if (result.error) parts.push("error: " + result.error);
  parts.push(
    "outcome: " +
      result.outcome.status +
      "/" +
      result.outcome.effectState +
      "/" +
      result.outcome.retry +
      " " +
      result.outcome.code +
      ". " +
      result.outcome.nextAction
  );
  return parts.join("\n");
}

export function registerFsTools(exposer: Exposer, workspaceManager: WorkspaceManager): void {
  exposer.expose("fs_read", {
    description: "Read a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ text: z.string() })
  }, async ({ path }) => {
    const text = await readTextFile(path, workspaceManager.currentRoot());
    return structuredResult({ text }, text);
  });

  const MAX_BATCH_READ_BYTES = 1024 * 1024;

  exposer.expose("fs_read_many", {
    description:
      "Read UTF-8 text files in one call. Legacy form {paths} reads 1-20 whole files with per-path errors and a 1 MiB total content limit. V2 form {contract_version:2, requests:[{path,offset,limit,expected_sha256?}], max_bytes?} returns versioned line ranges with raw-byte sha256, totalLines, text, complete, nextOffset and pendingIndexes; the whole MCP result is bounded by max_bytes (default 64 KiB, maximum 256 KiB).",
    inputSchema: fsReadManyInputSchema,
    outputSchema: fsReadManyOutputSchema
  }, async (input) => {
    // Snapshot the active root once so all paths in this batch use the same workspace.
    const workspaceRoot = workspaceManager.currentRoot();

    if (input.requests !== undefined) {
      const maxBytes = input.max_bytes ?? READ_LIMITS.defaultMaxBytes;
      const bounded = await readManyRanges(workspaceRoot, input.requests, maxBytes);
      return structuredResult(
        bounded.result,
        bounded.contentText,
        isOutcomeFailure(bounded.result.outcome)
      );
    }

    const paths = input.paths!;
    const files: Array<{
      path: string;
      ok: boolean;
      bytes: number;
      text?: string;
      error?: string;
    }> = [];
    let totalBytes = 0;
    let successCount = 0;

    for (const filePath of paths) {
      try {
        const text = await readTextFile(filePath, workspaceRoot);
        const bytes = Buffer.byteLength(text, "utf8");
        if (totalBytes + bytes > MAX_BATCH_READ_BYTES) {
          files.push({
            path: filePath,
            ok: false,
            bytes: 0,
            error: `Batch response limit exceeded (${MAX_BATCH_READ_BYTES} bytes); content omitted.`
          });
          continue;
        }

        totalBytes += bytes;
        successCount += 1;
        files.push({ path: filePath, ok: true, bytes, text });
      } catch (error) {
        files.push({
          path: filePath,
          ok: false,
          bytes: 0,
          error: error instanceof Error ? error.message : "Could not read the file."
        });
      }
    }

    const result = {
      files,
      totalBytes,
      successCount,
      failureCount: paths.length - successCount
    };
    const contentText = [
      "Read " + successCount + " of " + paths.length + " files; totalBytes=" + totalBytes + ".",
      ...files.map((file) => file.ok
        ? "OK " + file.path + " (" + file.bytes + " bytes)"
        : "FAILED " + file.path + ": " + (file.error ?? "Could not read the file."))
    ].join("\n");
    return structuredResult(result, contentText);
  });

  exposer.expose("fs_search", {
    description:
      "Search literal text recursively inside the active workspace. Skips protected paths, symbolic links, binary/oversized files and common generated directories. Legacy requests return bounded line snippets. V2 requests (contract_version:2) additionally return coverage {complete, stopReason, scannedFiles, skippedByReason} and an outcome; limit stops are partial/safe, while unreadable-path I/O errors are reported as errors.",
    inputSchema: fsSearchInputSchema,
    outputSchema: fsSearchOutputSchema
  }, async (input) => {
    const workspaceRoot = workspaceManager.currentRoot();

    if (input.contract_version === 2) {
      const result = await searchTextFilesV2(
        input.query,
        input.path ?? ".",
        workspaceRoot,
        { caseSensitive: input.case_sensitive, maxResults: input.max_results }
      );
      const summary = [
        "Search result: scanned=" + result.scannedFiles +
          ", matchedFiles=" + result.matchedFiles +
          ", matches=" + result.matchCount +
          ", skipped=" + result.skippedFiles +
          ", truncated=" + result.truncated + ".",
        "Coverage: complete=" + result.coverage.complete +
          ", stopReason=" + result.coverage.stopReason +
          ", scannedFiles=" + result.coverage.scannedFiles +
          ", skippedByReason=" + JSON.stringify(result.coverage.skippedByReason) + ".",
        "outcome: " + result.outcome.status + "/" + result.outcome.effectState +
          "/" + result.outcome.retry + " " + result.outcome.code + ". " +
          result.outcome.nextAction
      ].join("\n");
      return structuredResult(
        result,
        summary,
        isOutcomeFailure(result.outcome)
      );
    }

    const result = await searchTextFiles(
      input.query,
      input.path ?? ".",
      workspaceRoot,
      { caseSensitive: input.case_sensitive, maxResults: input.max_results }
    );
    const summary =
      "Search complete: scanned=" + result.scannedFiles +
      ", matchedFiles=" + result.matchedFiles +
      ", matches=" + result.matchCount +
      ", skipped=" + result.skippedFiles +
      ", truncated=" + result.truncated + ".";
    return structuredResult(result, summary);
  });

  exposer.expose("fs_write", {
    description: "Create or replace a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    outputSchema: z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative()
    })
  }, async ({ path: targetPath, content }) => {
    await assertWorkspaceWriteTarget(
      targetPath,
      workspaceManager.currentRoot()
    );
    const { bytes } = await writeTextFile(
      targetPath,
      content,
      workspaceManager.currentRoot()
    );
    return structuredResult(
      { path: targetPath, bytes },
      `Wrote ${bytes} bytes to ${targetPath}`
    );
  });

  exposer.expose("fs_write_many", {
    description:
      "Create or replace up to 20 UTF-8 files in one call. Prefer this over repeated fs_write calls for independent file updates. Preflights every target before mutation; replacing an existing file requires its expected_sha256; parent directories must already exist; total new content is capped at 1 MiB. On ordinary write failure, attempted changes are rolled back, but this is not crash-atomic.",
    inputSchema: z.object({
      files: z.array(z.object({
        path: z.string().min(1),
        content: z.string(),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
      })).min(1).max(20)
    }),
    outputSchema: z.object({
      status: z.literal("committed"),
      files: z.array(z.object({
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        created: z.boolean()
      })),
      totalBytes: z.number().int().nonnegative(),
      successCount: z.number().int().nonnegative()
    })
  }, async ({ files }) => {
    const workspaceRoot = workspaceManager.currentRoot();
    for (const file of files) {
      await assertWorkspaceWriteTarget(file.path, workspaceRoot);
    }
    const results = await writeTextFilesBatch(
      files.map((file) => ({
        path: file.path,
        content: file.content,
        ...(file.expected_sha256 ? { expectedSha256: file.expected_sha256 } : {})
      })),
      workspaceRoot
    );
    const result = {
      status: "committed" as const,
      files: results,
      totalBytes: results.reduce((total, file) => total + file.bytes, 0),
      successCount: results.length
    };
    return structuredResult(
      result,
      "Committed " + results.length + " file writes; totalBytes=" + result.totalBytes + "."
    );
  });

  exposer.expose("apply_patch", {
    description: "Patch one exact text occurrence after verifying expected SHA-256.",
    inputSchema: z.object({
      path: z.string().min(1),
      expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      old_text: z.string().min(1),
      new_text: z.string()
    }),
    outputSchema: z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/)
    })
  }, async ({ path, expected_sha256, old_text, new_text }) => {
    await assertWorkspaceWriteTarget(
      path,
      workspaceManager.currentRoot()
    );
    const result = await patchTextFile(
      path,
      expected_sha256,
      old_text,
      new_text,
      workspaceManager.currentRoot()
    );
    return structuredResult(
      { path, bytes: result.bytes, sha256: result.sha256 },
      `Patched ${result.bytes} bytes; sha256=${result.sha256}`
    );
  });

  exposer.expose("apply_patch_many", {
    description:
      "Apply exact text patches to up to 20 independent files in one call. Legacy form uses one old_text/new_text pair per file. V2 form {contract_version:2, dry_run?, patches:[{path,expected_sha256,edits:[{old_text,new_text}]}]} locates 1-100 edits per file against the same reviewed revision, rejects ambiguous or overlapping edits, and preflights the whole batch before writing. dry_run returns the expected new hashes and a bounded diff without writing. Ordinary write failures trigger rollback; files changed externally during rollback are preserved and reported as effect unknown.",
    inputSchema: applyPatchManyInputSchema,
    outputSchema: applyPatchManyOutputSchema
  }, async (input) => {
    const workspaceRoot = workspaceManager.currentRoot();
    const patches = input.patches!;

    if (input.contract_version === 2) {
      const v2Patches = patches.map((patch) => {
        if (patch.edits === undefined) {
          throw new Error("V2 patch requires edits.");
        }
        return {
          path: patch.path,
          expectedSha256: patch.expected_sha256,
          edits: patch.edits
        };
      });
      for (const patch of v2Patches) {
        await assertWorkspaceWriteTarget(patch.path, workspaceRoot);
      }
      const result = await patchTextFilesBatchV2(v2Patches, workspaceRoot, {
        dryRun: input.dry_run === true
      });
      return structuredResult(
        result,
        renderPatchBatchContent(result),
        isOutcomeFailure(result.outcome)
      );
    }

    const legacyPatches = patches.map((patch) => {
      if (patch.old_text === undefined || patch.new_text === undefined) {
        throw new Error("Legacy patch requires old_text and new_text.");
      }
      return {
        path: patch.path,
        expectedSha256: patch.expected_sha256,
        oldText: patch.old_text,
        newText: patch.new_text
      };
    });
    for (const patch of legacyPatches) {
      await assertWorkspaceWriteTarget(patch.path, workspaceRoot);
    }
    const results = await patchTextFilesBatch(legacyPatches, workspaceRoot);
    const result = {
      status: "committed" as const,
      files: results,
      totalBytes: results.reduce((total, file) => total + file.bytes, 0),
      successCount: results.length
    };
    return structuredResult(
      result,
      "Committed " + results.length + " file patches; totalBytes=" + result.totalBytes + "."
    );
  });

  exposer.expose("fs_list", {
    description: "List direct children of a directory inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ entries: z.array(z.string()) })
  }, async ({ path }) => {
    const entries = await listDirectory(path, workspaceManager.currentRoot());
    return structuredResult({ entries }, entries.join("\n"));
  });
}
