import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { listDirectory, patchTextFile, readTextFile, writeTextFile } from "./files.js";
import { structuredResult } from "./result.js";

export function registerFsTools(exposer: Exposer, workspaceManager: WorkspaceManager): void {
  exposer.expose("fs_read", {
    description: "Read a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ text: z.string() })
  }, async ({ path }) => {
    const text = await readTextFile(path, workspaceManager.currentRoot());
    return structuredResult({ text }, text);
  });

  exposer.expose("fs_write", {
    description: "Create or replace a UTF-8 text file inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    outputSchema: z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative()
    })
  }, async ({ path: targetPath, content }) => {
    const { bytes } = await writeTextFile(targetPath, content, workspaceManager.currentRoot());
    return structuredResult(
      { path: targetPath, bytes },
      `Wrote ${bytes} bytes to ${targetPath}`
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

  exposer.expose("fs_list", {
    description: "List direct children of a directory inside the active workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ entries: z.array(z.string()) })
  }, async ({ path }) => {
    const entries = await listDirectory(path, workspaceManager.currentRoot());
    return structuredResult({ entries }, entries.join("\n"));
  });
}
