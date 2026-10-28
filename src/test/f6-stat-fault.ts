/**
 * Test-only preload used by the real stdio MCP regression for F6.
 *
 * NODE_OPTIONS=--import=.../f6-stat-fault.js and P05_F6_FAULT_TARGET=<basename>
 * makes the first `stat()` on that newly created handle fail with EIO. This is
 * not exposed by the production MCP schema or handlers.
 */
import fs from "node:fs/promises";
import path from "node:path";

const target = process.env.P05_F6_FAULT_TARGET;
const requested = Number(process.env.P05_F6_FAULT_COUNT ?? "1");
let remaining = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;

if (target) {
  const originalOpen = fs.open.bind(fs) as (...args: any[]) => Promise<any>;
  (fs as unknown as { open: typeof originalOpen }).open = async (
    file: any,
    flags: any,
    ...args: any[]
  ) => {
    const handle = await originalOpen(file, flags, ...args);
    if (
      path.basename(String(file)) !== target ||
      !String(flags).includes("x") ||
      remaining <= 0
    ) {
      return handle;
    }

    const originalStat = handle.stat.bind(handle);
    handle.stat = async (...statArgs: any[]) => {
      if (remaining > 0) {
        remaining -= 1;
        const error = new Error("EIO: injected stat failure");
        (error as { code?: string }).code = "EIO";
        throw error;
      }
      return originalStat(...statArgs);
    };
    return handle;
  };
}
