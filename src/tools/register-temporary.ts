import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import { listTempDirectory, readTempFile } from "./temp-readonly.js";
import { structuredResult } from "./result.js";

export function registerTemporaryTools(exposer: Exposer): void {
  exposer.expose("list_directory", {
    description: "TEMPORARY: list direct children inside the temporary read-only root.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ entries: z.array(z.string()) })
  }, async ({ path }) => {
    const entries = await listTempDirectory(path);
    return structuredResult({ entries }, entries.join("\n"));
  });

  exposer.expose("read_file", {
    description: "TEMPORARY: read a UTF-8 text file inside the temporary read-only root.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: z.object({ text: z.string() })
  }, async ({ path }) => {
    const text = await readTempFile(path);
    return structuredResult({ text }, text);
  });
}
