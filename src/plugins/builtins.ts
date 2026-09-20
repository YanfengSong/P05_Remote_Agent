import type { ApplicationPlugin } from "../plugin/types.js";
import { matlabPlugin } from "./matlab/plugin.js";
import { referenceAgentPlugin } from "./agents/reference/plugin.js";

/**
 * Explicitly compiled-in plugins only.
 *
 * P05 intentionally does not scan directories or import arbitrary paths as executable
 * plugins. Adding a new built-in plugin is a reviewed source change until a signed or
 * otherwise authenticated external plugin distribution model exists.
 */
export const BUILTIN_PLUGINS: readonly ApplicationPlugin[] = [
  matlabPlugin,
  referenceAgentPlugin
];
