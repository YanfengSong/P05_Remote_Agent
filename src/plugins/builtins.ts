import type { ApplicationPlugin } from "../plugin/types.js";
import { LOCAL_PLUGINS } from "./catalog.js";

/**
 * Backward-compatible assembly name for the current P05 boot path.
 *
 * Plugin-specific imports live in ./catalog.ts, not in P05 Core.
 */
export const BUILTIN_PLUGINS: readonly ApplicationPlugin[] = LOCAL_PLUGINS;
