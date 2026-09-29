import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { ReferenceManager } from "../reference/manager.js";
import { listDirectory, readTextFile } from "./files.js";
import { structuredResult } from "./result.js";

export function registerReferenceTools(
  exposer: Exposer,
  referenceManager: ReferenceManager
): void {
  exposer.expose("reference_list", {
    description: "List locally authorized read-only reference roots by logical id and label. Host root paths are not returned.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      references: z.array(z.object({
        id: z.string(),
        label: z.string()
      }))
    })
  }, async () => {
    const references = referenceManager.list();
    return structuredResult({ references }, JSON.stringify(references, null, 2));
  });

  exposer.expose("reference_read", {
    description: "Read a UTF-8 text file inside one locally authorized read-only reference root.",
    inputSchema: z.object({
      reference_id: z.string().min(1),
      path: z.string().min(1)
    }),
    outputSchema: z.object({ text: z.string() })
  }, async ({ reference_id, path }) => {
    const reference = referenceManager.get(reference_id);
    const text = await readTextFile(path, reference.root);
    return structuredResult({ text }, text);
  });

  exposer.expose("reference_list_directory", {
    description: "List direct children inside one locally authorized read-only reference root.",
    inputSchema: z.object({
      reference_id: z.string().min(1),
      path: z.string().min(1).optional()
    }),
    outputSchema: z.object({ entries: z.array(z.string()) })
  }, async ({ reference_id, path }) => {
    const reference = referenceManager.get(reference_id);
    const entries = await listDirectory(path ?? ".", reference.root);
    return structuredResult({ entries }, entries.join("\n"));
  });
}
