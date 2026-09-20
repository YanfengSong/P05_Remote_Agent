/**
 * Environment helpers with no side effects.
 *
 * This module exists so that code which only needs to *read* an environment variable does not
 * have to import `src/config.ts`: that module assembles and validates configuration at import
 * time (an unset allowed root aborts startup), which must not happen as a side effect of
 * importing the tool-profile policy — `src/test/policy-profiles.ts` sets the root variables
 * after its imports and would otherwise fail on import order.
 */

/** The temporary read-only layer's opt-in variable (TMP-R01, see docs/adr/ADR-0006). */
export const TEMP_READONLY_ROOT_ENV = "P05_TEMP_READONLY_ROOT";

/**
 * Read an environment variable as an own property only.
 *
 * `process.env` inherits from Object.prototype, so a polluted prototype would otherwise make
 * `process.env[name]` answer for a variable that was never set - and here that value decides
 * which roots are reachable and which tool profile is active.
 */
export function readOwnEnv(name: string): string | undefined {
  return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
}
