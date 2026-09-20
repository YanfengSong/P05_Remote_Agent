import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { SearchRuntime } from "../search/runtime.js";
import { SEARCH_STATES } from "../search/types.js";
import { structuredResult } from "./result.js";

const searchStateSchema = z.enum(SEARCH_STATES);

const searchStatusSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  mode: z.enum(["text", "name"]),
  state: searchStateSchema,
  startedAt: z.string(),
  lastActivityAt: z.string(),
  finishedAt: z.string().optional(),
  resultCount: z.number().int().nonnegative(),
  scannedFiles: z.number().int().nonnegative(),
  limited: z.boolean(),
  limitReason: z.enum(["max-results", "timeout"]).optional(),
  error: z.string().optional()
});

const searchResultSchema = z.object({
  index: z.number().int().nonnegative(),
  path: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  preview: z.string().optional()
});

export function registerSearchTools(
  exposer: Exposer,
  searchRuntime: SearchRuntime
): void {
  exposer.expose("search_start", {
    description: "Start a bounded asynchronous literal text or file-name search in the active workspace.",
    inputSchema: z.object({
      mode: z.enum(["text", "name"]),
      query: z.string().min(1),
      path: z.string().min(1).optional(),
      case_sensitive: z.boolean().optional(),
      max_results: z.number().int().min(1).max(5000).optional(),
      timeout_ms: z.number().int().min(1000).max(120000).optional()
    }),
    outputSchema: searchStatusSchema
  }, async ({ mode, query, path, case_sensitive, max_results, timeout_ms }) => {
    const result = await searchRuntime.start({
      mode,
      query,
      path,
      caseSensitive: case_sensitive,
      maxResults: max_results,
      timeoutMs: timeout_ms
    });
    return structuredResult(result);
  });

  exposer.expose("search_more", {
    description: "Read one bounded page of currently available results from an asynchronous search.",
    inputSchema: z.object({
      search_id: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional()
    }),
    outputSchema: z.object({
      searchId: z.string(),
      workspaceId: z.string(),
      state: searchStateSchema,
      results: z.array(searchResultSchema),
      nextCursor: z.number().int().nonnegative(),
      done: z.boolean(),
      totalAvailable: z.number().int().nonnegative(),
      limited: z.boolean(),
      limitReason: z.enum(["max-results", "timeout"]).optional()
    })
  }, async ({ search_id, cursor, limit }) => {
    const result = searchRuntime.page(search_id, cursor ?? 0, limit ?? 50);
    return structuredResult(result);
  });

  exposer.expose("search_status", {
    description: "List search sessions for the active workspace, or inspect one search session.",
    inputSchema: z.object({
      search_id: z.string().min(1).optional()
    }),
    outputSchema: z.object({
      searches: z.array(searchStatusSchema)
    })
  }, async ({ search_id }) => {
    const searches = search_id
      ? [searchRuntime.status(search_id)]
      : searchRuntime.list();
    return structuredResult({ searches });
  });

  exposer.expose("search_stop", {
    description: "Stop an asynchronous search session in the active workspace.",
    inputSchema: z.object({
      search_id: z.string().min(1)
    }),
    outputSchema: searchStatusSchema
  }, async ({ search_id }) => {
    const result = searchRuntime.stop(search_id);
    return structuredResult(result);
  });
}
