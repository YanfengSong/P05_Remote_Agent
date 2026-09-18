/**
 * Policy unit checks. No MCP transport involved: this exercises the gate, the
 * catalog invariants and the protected-path rules directly.
 *
 * Run: npm run test:policy
 */
import { PROFILE_NAMES, PROFILE_RANK, TOOL_SPECS, specFor } from "../policy/spec.js";
import { createToolGate, isTruthyFlag, normalizeProfile } from "../policy/gate.js";

let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function sameSet(label: string, actual: string[], expected: string[]): void {
  const a = sorted(actual).join(",");
  const e = sorted(expected).join(",");
  check(label, a === e, `expected [${e}] got [${a}]`);
}

function throws(label: string, fn: () => unknown, mustContain?: string): string {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mustContain) check(label, message.includes(mustContain), `message was "${message}"`);
    else checks += 1;
    return message;
  }
  throw new Error(`FAIL ${label} -> expected a throw, nothing was thrown`);
}

const SAFE_SET = ["device_info", "fs_list", "fs_read", "ping", "policy_info"];
const DEV_SET = [...SAFE_SET, "mcp_list_tools", "mcp_status"];

// ---------------------------------------------------------------- catalog invariants
for (const spec of TOOL_SPECS) {
  check(`catalog: ${spec.name} declares a known profile`, PROFILE_NAMES.includes(spec.minProfile), spec.minProfile);
  check(`catalog: ${spec.name} has a summary`, spec.summary.length > 10);
  if (spec.risk === "write" || spec.risk === "execute") {
    check(`catalog: ${spec.name} (risk=${spec.risk}) must require a local unlock flag`, Boolean(spec.unlockFlag));
  }
}

// ---------------------------------------------------------------- profile resolution
check("profile: unset falls back to safe", normalizeProfile(undefined).profile === "safe");
check("profile: unset records the default source", normalizeProfile(undefined).source === "default");
check("profile: empty string falls back to safe", normalizeProfile("").profile === "safe");
check("profile: value is trimmed and case-folded", normalizeProfile("  DEV ").profile === "dev");
check("profile: env source recorded", normalizeProfile("full").source === "env");
throws("profile: unknown value is rejected", () => normalizeProfile("godmode"), "Unknown P05_TOOL_PROFILE");

// ---------------------------------------------------------------- unlock flag parsing
for (const truthy of ["1", "true", "TRUE", "yes", " On "]) {
  check(`flag: "${truthy}" is on`, isTruthyFlag(truthy));
}
for (const falsy of [undefined, "", "0", "false", "no", "2", "enabled"]) {
  check(`flag: ${JSON.stringify(falsy)} is off`, !isTruthyFlag(falsy));
}

// ---------------------------------------------------------------- exposure decisions
const safeGate = createToolGate({});
sameSet("gate: default profile exposes the read-only set", safeGate.report().exposed, SAFE_SET);
check("gate: default profile hides shell_run", !safeGate.isExposed("shell_run"));
check("gate: default profile hides fs_write", !safeGate.isExposed("fs_write"));
check("gate: default profile hides mcp_call_tool", !safeGate.isExposed("mcp_call_tool"));

const devGate = createToolGate({ P05_TOOL_PROFILE: "dev" });
sameSet("gate: dev adds the downstream read tools", devGate.report().exposed, DEV_SET);
check("gate: dev alone does not unlock fs_write", !devGate.isExposed("fs_write"));

const devWriteGate = createToolGate({ P05_TOOL_PROFILE: "dev", P05_ENABLE_FS_WRITE: "true" });
check("gate: dev + unlock exposes fs_write", devWriteGate.isExposed("fs_write"));

const fullNoUnlock = createToolGate({ P05_TOOL_PROFILE: "full" });
sameSet("gate: full without unlocks grants nothing dangerous", fullNoUnlock.report().exposed, DEV_SET);
check("gate: full without unlock still hides shell_run", !fullNoUnlock.isExposed("shell_run"));
check("gate: full without unlock still hides mcp_call_tool", !fullNoUnlock.isExposed("mcp_call_tool"));

const fullGate = createToolGate({
  P05_TOOL_PROFILE: "full",
  P05_ENABLE_SHELL: "1",
  P05_ENABLE_FS_WRITE: "1",
  P05_ENABLE_DOWNSTREAM_EXEC: "1"
});
check("gate: full + unlock exposes shell_run", fullGate.isExposed("shell_run"));
check("gate: full + unlock exposes mcp_call_tool", fullGate.isExposed("mcp_call_tool"));

const shellOnly = createToolGate({ P05_TOOL_PROFILE: "full", P05_ENABLE_SHELL: "1" });
check("gate: shell unlock alone does not expose mcp_call_tool", !shellOnly.isExposed("mcp_call_tool"));

const report = shellOnly.report();
const shellSuppressed = report.suppressed.find((entry) => entry.tool === "shell_run");
check("gate: report: shell_run is not listed as suppressed once unlocked", shellSuppressed === undefined);
const execSuppressed = report.suppressed.find((entry) => entry.tool === "mcp_call_tool");
check(
  "gate: report: suppression reason names the missing unlock flag",
  Boolean(execSuppressed?.reason.includes("P05_ENABLE_DOWNSTREAM_EXEC")),
  execSuppressed?.reason
);

// ---------------------------------------------------------------- undeclared tools
throws("gate: undeclared tool name is refused", () => safeGate.isExposed("rm_rf_everything"), "not declared");
throws("gate: assertExposed refuses a suppressed tool", () => safeGate.assertExposed("shell_run"));
check("gate: assertExposed passes for an exposed tool", (() => { safeGate.assertExposed("fs_read"); return true; })());

// ---------------------------------------------------------------- protected paths
process.env.REMOTE_AGENT_ALLOWED_ROOTS = process.platform === "win32" ? "D:\\Project_Git" : "/srv/project_git";
const { assertAccessiblePath } = await import("../security.js");
const root = process.platform === "win32" ? "D:\\Project_Git" : "/srv/project_git";
const p = (...parts: string[]) => [root, ...parts].join(process.platform === "win32" ? "\\" : "/");

check("path: ordinary source file is allowed", Boolean(assertAccessiblePath(p("P05_Remote_Agent", "src", "index.ts"), "read")));
check("path: outside allowed roots is refused", (() => {
  try { assertAccessiblePath(process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts", "read"); return false; }
  catch (error) { return String(error).includes("outside allowed roots"); }
})());
throws("path: .env read is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".env"), "read"), "may hold secrets");
throws("path: .env.local read is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".env.local"), "read"), "may hold secrets");
check("path: .env.example template stays readable", Boolean(assertAccessiblePath(p("P05_Remote_Agent", ".env.example"), "read")));
throws("path: .git/hooks write is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".git", "hooks", "pre-commit"), "write"), "protected");
throws("path: .git/config write is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".git", "config"), "write"), "protected");
throws("path: .p05 state write is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".p05", "device.json"), "write"), "protected");
throws("path: .npmrc write is refused", () => assertAccessiblePath(p("P05_Remote_Agent", ".npmrc"), "write"), "may hold secrets");
throws("path: private key write is refused", () => assertAccessiblePath(p("certs", "server.pem"), "write"), "private keys");
check("path: nested .git is caught", (() => {
  try { assertAccessiblePath(p("other-repo", ".git", "config"), "read"); return false; }
  catch { return true; }
})());

// ---------------------------------------------------------------- already-declared spec lookup
check("spec: lookup finds a declared tool", specFor("shell_run")?.minProfile === "full");
check("spec: lookup returns undefined for an unknown tool", specFor("nope") === undefined);
check("spec: profile ranking is ordered", PROFILE_RANK.safe < PROFILE_RANK.dev && PROFILE_RANK.dev < PROFILE_RANK.full);

console.log(`POLICY_PROFILES_OK (${checks} checks)`);
