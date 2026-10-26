import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { listDirectory, patchTextFile, patchTextFilesBatch, readTextFile, searchTextFiles, writeTextFile, writeTextFilesBatch } from "./files.js";
import { structuredResult } from "./result.js";
import { assertWorkspaceWriteTarget } from "./write-target.js";

export function registerFsTools(exposer: Exposer, workspaceManager: WorkspaceManager): void {
  exposer.expose("fs_read", {
    description: "Read a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ text: z.string() })
  }, async ({ path }) => {
    const text = await readTextFile(path, workspaceManager.currentRoot());
    return structuredResult({ text }, text);
  });

  const MAX_BATCH_READ_FILES = 20;
  const MAX_BATCH_READ_BYTES = 1024 * 1024;

  exposer.expose("fs_read_many", {
    description:
      "Read multiple independent UTF-8 text files in one call. Prefer this over repeated fs_read calls when paths are independent. Accepts 1 to 20 paths; each file is checked against the active workspace policy, failures are reported per path, and returned file contents are capped at 1 MiB total.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1)).min(1).max(MAX_BATCH_READ_FILES)
    }),
    outputSchema: z.object({
      files: z.array(z.object({
        path: z.string(),
        ok: z.boolean(),
        bytes: z.number().int().nonnegative(),
        text: z.string().optional(),
        error: z.string().optional()
      })),
      totalBytes: z.number().int().nonnegative(),
      successCount: z.number().int().nonnegative(),
      failureCount: z.number().int().nonnegative()
    })
  }, async ({ paths }) => {
    // Snapshot the active root once so all paths in this batch use the same workspace.
    const workspaceRoot = workspaceManager.currentRoot();
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
      "Search literal text recursively inside the active workspace. Prefer this over reading many files just to find a symbol or phrase. Skips protected paths, symbolic links, binary/oversized files and common generated directories; scans at most 5,000 files or 32 MiB and returns bounded line snippets.",
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      path: z.string().min(1).optional(),
      case_sensitive: z.boolean().optional(),
      max_results: z.number().int().min(1).max(100).optional()
    }),
    outputSchema: z.object({
      query: z.string(),
      root: z.string(),
      scannedFiles: z.number().int().nonnegative(),
      skippedFiles: z.number().int().nonnegative(),
      totalBytesScanned: z.number().int().nonnegative(),
      matchCount: z.number().int().nonnegative(),
      matchedFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
      results: z.array(z.object({
        path: z.string(),
        matchCount: z.number().int().nonnegative(),
        matches: z.array(z.object({
          line: z.number().int().positive(),
          occurrences: z.number().int().positive(),
          snippet: z.string()
        })),
        matchesTruncated: z.boolean()
      }))
    })
  }, async ({ query, path: searchPath, case_sensitive, max_results }) => {
    const workspaceRoot = workspaceManager.currentRoot();
    const result = await searchTextFiles(
      query,
      searchPath ?? ".",
      workspaceRoot,
      { caseSensitive: case_sensitive, maxResults: max_results }
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
      "Apply exact text patches to up to 20 independent files in one call. Prefer this over repeated apply_patch calls. Every file must provide its reviewed expected_sha256, and old_text must occur exactly once. All files are preflighted before mutation; total resulting content is capped at 1 MiB and ordinary write failures trigger rollback, but the batch is not crash-atomic.",
    inputSchema: z.object({
      patches: z.array(z.object({
        path: z.string().min(1),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        old_text: z.string().min(1),
        new_text: z.string()
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
  }, async ({ patches }) => {
    const workspaceRoot = workspaceManager.currentRoot();
    for (const patch of patches) {
      await assertWorkspaceWriteTarget(patch.path, workspaceRoot);
    }
    const results = await patchTextFilesBatch(
      patches.map((patch) => ({
        path: patch.path,
        expectedSha256: patch.expected_sha256,
        oldText: patch.old_text,
        newText: patch.new_text
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
