import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertAccessiblePath } from "../security.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;

export const DEVELOPER_ACTIONS = [
  "check",
  "build",
  "test_policy",
  "test_exposure",
  "test_temp_readonly",
  "test_foundation",
  "test_git_mutations",
  "test_plugin_framework",
  "test_output_schema",
  "test_process_runtime",
  "test_search_runtime",
  "test_isolation",
  "test_agent_runtime",
  "test_audit_correlation",
  "test_run_kernel",
  "smoke_downstream",
  "verify"
] as const;

export type DeveloperAction = (typeof DEVELOPER_ACTIONS)[number];

function asDeveloperAction(action: string): DeveloperAction {
  if (!(DEVELOPER_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`Unknown developer action "${action}". Allowed: ${DEVELOPER_ACTIONS.join(", ")}.`);
  }
  return action as DeveloperAction;
}

function bounded(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return text;
  return Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n[TRUNCATED: command output exceeded 256 KiB]";
}

async function runNodeScript(
  label: string,
  script: string,
  args: string[],
  platformRoot: string
): Promise<string> {
  const cwd = await assertAccessiblePath(platformRoot, "read", platformRoot, platformRoot);
  const target = await assertAccessiblePath(path.join(cwd, script), "read", platformRoot, platformRoot);

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [target, ...args], {
      cwd,
      // Developer self-tests must not inherit optional exposure gates from the live Agent.
      env: {
        ...process.env,
        P05_TEMP_READONLY_ROOT: "",
        REMOTE_AGENT_DEFAULT_CWD: ""
      },
      timeout: 300_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    const text = [
      `ACTION ${label} OK`,
      stdout ? `STDOUT:\n${stdout}` : "",
      stderr ? `STDERR:\n${stderr}` : ""
    ].filter(Boolean).join("\n");
    return bounded(text.trimEnd());
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(bounded([
      `ACTION ${label} FAILED`,
      stdout ? `STDOUT:\n${stdout}` : "",
      stderr ? `STDERR:\n${stderr}` : "",
      !stdout && !stderr && error?.message ? String(error.message) : ""
    ].filter(Boolean).join("\n")));
  }
}

async function runSingle(action: Exclude<DeveloperAction, "verify">, platformRoot: string): Promise<string> {
  switch (action) {
    case "check":
      return runNodeScript("check", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.json", "--noEmit"], platformRoot);
    case "build":
      return runNodeScript("build", "node_modules/typescript/bin/tsc", ["-p", "tsconfig.json"], platformRoot);
    case "test_policy":
      return runNodeScript("test_policy", "dist/test/policy-profiles.js", [], platformRoot);
    case "test_exposure":
      return runNodeScript("test_exposure", "dist/test/profile-exposure.js", [], platformRoot);
    case "test_temp_readonly":
      return runNodeScript("test_temp_readonly", "dist/test/temp-readonly.js", [], platformRoot);
    case "test_foundation":
      return runNodeScript("test_foundation", "dist/test/foundation.js", [], platformRoot);
    case "test_git_mutations":
      return runNodeScript("test_git_mutations", "dist/test/git-mutations.js", [], platformRoot);
    case "test_plugin_framework":
      return runNodeScript("test_plugin_framework", "dist/test/plugin-framework.js", [], platformRoot);
    case "test_output_schema":
      return runNodeScript("test_output_schema", "dist/test/output-schema.js", [], platformRoot);
    case "test_process_runtime":
      return runNodeScript("test_process_runtime", "dist/test/process-runtime.js", [], platformRoot);
    case "test_search_runtime":
      return runNodeScript("test_search_runtime", "dist/test/search-runtime.js", [], platformRoot);
    case "test_isolation":
      return runNodeScript("test_isolation", "dist/test/isolation.js", [], platformRoot);
    case "test_agent_runtime":
      return runNodeScript("test_agent_runtime", "dist/test/agent-runtime.js", [], platformRoot);
    case "test_audit_correlation":
      return runNodeScript("test_audit_correlation", "dist/test/audit-correlation.js", [], platformRoot);
    case "test_run_kernel":
      return runNodeScript("test_run_kernel", "dist/test/run-kernel.js", [], platformRoot);
    case "smoke_downstream":
      return runNodeScript("smoke_downstream", "dist/test/downstream-smoke.js", [], platformRoot);
  }
}

/**
 * Stable remote schema, strict local allowlist.
 *
 * The MCP caller supplies only an action name. It never supplies an executable, shell string,
 * cwd or arbitrary args. New workspace-level validation actions can be added to this allowlist
 * without changing the MCP schema; host-level authority still belongs to external brokers.
 */
export async function runDeveloperAction(requestedAction: string, platformRoot: string): Promise<string> {
  const action = asDeveloperAction(requestedAction);
  if (action !== "verify") return runSingle(action, platformRoot);

  const steps: Exclude<DeveloperAction, "verify">[] = [
    "check",
    "build",
    "smoke_downstream",
    "test_policy",
    "test_exposure",
    "test_temp_readonly",
    "test_foundation",
    "test_git_mutations",
    "test_plugin_framework",
    "test_output_schema",
    "test_process_runtime",
    "test_search_runtime",
    "test_isolation",
    "test_agent_runtime",
    "test_audit_correlation",
    "test_run_kernel"
  ];
  const results: string[] = [];
  for (const step of steps) results.push(await runSingle(step, platformRoot));
  return bounded(["ACTION verify OK", ...results].join("\n\n"));
}