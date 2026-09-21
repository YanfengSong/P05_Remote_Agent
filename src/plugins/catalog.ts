import type { ApplicationPlugin } from "../plugin/api.js";
import { examplePlugin } from "./example/plugin.js";
import { matlabPlugin } from "./matlab/plugin.js";

/**
 * Source-controlled local plugin catalog.
 *
 * New first-party/private plugins are added here. P05 Core imports only the
 * catalog surface and does not need plugin-specific imports.
 */
export const LOCAL_PLUGINS: readonly ApplicationPlugin[] = [
  matlabPlugin,
  examplePlugin
];
