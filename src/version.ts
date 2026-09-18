/**
 * Single source of truth for the project version.
 *
 * `package.json`, the MCP server identity handed to clients and the downstream client
 * identity all read this value; `src/test/policy-profiles.ts` asserts that package.json
 * agrees, so the three can no longer drift apart.
 */
export const VERSION = "0.3.0";
