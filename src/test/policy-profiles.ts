/**
 * Tool profile policy checks. No MCP transport involved: this exercises the profile
 * matrix, the catalog invariants and the path/command guards directly.
 *
 * Run: npm run test:policy
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TOOL_PROFILE,
  PLANNED_TOOLS,
  PROFILE_RANK,
  TOOL_PROFILE_NAMES,
  TOOL_SPECS,
  isToolAllowed,
  resolveToolProfile,
  specFor,
  toolDecision,
  toolProfileReport
} from "../policy/tool-profile.js";
import { runtimeRestartInvocation } from "../tools/runtime.js";

// Keep this suite independent from the live Agent's machine-specific exposure/runtime settings.
delete process.env.REMOTE_AGENT_DEFAULT_CWD;

let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameSet(label: string, actual: readonly string[], expected: readonly string[]): void {
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

// The plan's per-profile lists, restricted to the tools implemented today.
const DISCOVERY_TOOLS = ["device_info", "ping"];
const READONLY_TOOLS = [...DISCOVERY_TOOLS, "workspace_list", "workspace_current", "reference_list", "reference_read", "reference_list_directory", "activity_recent", "recovery_status", "plugin_list", "fs_read", "fs_list", "git_status", "git_diff", "git_diff_stat"];
// mcp_call_tool is deliberately NOT here: it is a generic proxy, and the plan lists it
// under "never expose initially" next to shell_run. It sits at `full`.
const DEVELOPER_TOOLS = [...READONLY_TOOLS, "fs_write", "apply_patch", "git_add", "git_commit", "git_branch", "command_run", "runtime_restart", "mcp_list_tools", "mcp_status", "shell_run"];
const FULL_TOOLS = [...DEVELOPER_TOOLS, "mcp_call_tool", "git_push"];

// ---------------------------------------------------------------- catalog invariants
for (const spec of TOOL_SPECS) {
  check(`catalog: ${spec.name} declares a known profile`, TOOL_PROFILE_NAMES.includes(spec.minProfile), spec.minProfile);
  check(`catalog: ${spec.name} has a summary`, spec.summary.length > 10);
}
check("catalog: profile ranking is ordered",
  PROFILE_RANK.discovery < PROFILE_RANK.readonly &&
  PROFILE_RANK.readonly < PROFILE_RANK.developer &&
  PROFILE_RANK.developer < PROFILE_RANK.full);
check("catalog: the default is discovery", DEFAULT_TOOL_PROFILE === "discovery");
check("catalog: full is never the default", DEFAULT_TOOL_PROFILE !== "full");
check("catalog: tool names are unique", new Set(TOOL_SPECS.map((s) => s.name)).size === TOOL_SPECS.length);
for (const [profile, planned] of Object.entries(PLANNED_TOOLS)) {
  for (const name of planned) {
    check(`catalog: planned ${name} (${profile}) is not exposable before it exists`, specFor(name) === undefined);
  }
}

// ---------------------------------------------------------------- profile resolution
check("profile: unset falls back to discovery", resolveToolProfile(undefined).profile === "discovery");
check("profile: unset records the default source", resolveToolProfile(undefined).profileSource === "default");
check("profile: empty string falls back to discovery", resolveToolProfile("").profile === "discovery");
check("profile: value is trimmed and case-folded", resolveToolProfile("  READONLY ").profile === "readonly");
check("profile: env source recorded", resolveToolProfile("full").profileSource === "env");
throws("profile: unknown value is rejected", () => resolveToolProfile("safe"), "Unknown P05_TOOL_PROFILE");
throws("profile: old invented value is rejected", () => resolveToolProfile("dev"), "Unknown P05_TOOL_PROFILE");

// ---------------------------------------------------------------- the matrix
sameSet("matrix: discovery", toolProfileReport("discovery", "env").exposed, DISCOVERY_TOOLS);
sameSet("matrix: readonly", toolProfileReport("readonly", "env").exposed, READONLY_TOOLS);
sameSet("matrix: developer", toolProfileReport("developer", "env").exposed, DEVELOPER_TOOLS);
sameSet("matrix: full", toolProfileReport("full", "env").exposed, FULL_TOOLS);

for (const name of DISCOVERY_TOOLS) {
  check(`matrix: discovery allows ${name}`, isToolAllowed("discovery", name));
}
for (const name of READONLY_TOOLS) {
  check(`matrix: readonly allows ${name}`, isToolAllowed("readonly", name));
}
for (const name of DEVELOPER_TOOLS) {
  check(`matrix: developer allows ${name}`, isToolAllowed("developer", name));
}

// The TASK-001 DoD: these must not be reachable from discovery.
for (const forbidden of ["shell_run", "fs_write", "mcp_call_tool"]) {
  check(`DoD: discovery hides ${forbidden}`, !isToolAllowed("discovery", forbidden));
}
check("DoD: discovery is exactly device_info + ping",
  toolProfileReport("discovery", "env").exposed.length === 2);

// Review fix: the generic downstream proxy is a `full` tool, not a `developer` one.
check("matrix: the generic downstream proxy sits at full", specFor("mcp_call_tool")?.minProfile === "full");
check("matrix: developer cannot reach the generic downstream proxy", !isToolAllowed("developer", "mcp_call_tool"));
check("matrix: full can reach the generic downstream proxy", isToolAllowed("full", "mcp_call_tool"));
check("matrix: developer can reach shell_run", isToolAllowed("developer", "shell_run"));
check("matrix: readonly cannot reach shell_run", !isToolAllowed("readonly", "shell_run"));
check("matrix: readonly can inspect workspaces", isToolAllowed("readonly", "workspace_list") && isToolAllowed("readonly", "workspace_current"));
check("matrix: remote workspace switch is not a capability", specFor("workspace_switch") === undefined);
check("matrix: activity is readonly", isToolAllowed("readonly", "activity_recent"));
check("matrix: git mutation profiles", isToolAllowed("developer", "git_add") && isToolAllowed("developer", "git_commit") && isToolAllowed("developer", "git_branch") && !isToolAllowed("developer", "git_push") && isToolAllowed("full", "git_push"));

// Cumulative nesting: each profile is a superset of the one below it.
for (let i = 1; i < TOOL_PROFILE_NAMES.length; i += 1) {
  const lower = TOOL_PROFILE_NAMES[i - 1]!;
  const upper = TOOL_PROFILE_NAMES[i]!;
  const upperSet = new Set(toolProfileReport(upper, "env").exposed);
  for (const name of toolProfileReport(lower, "env").exposed) {
    check(`matrix: ${upper} includes ${lower}'s ${name}`, upperSet.has(name));
  }
}

check("decision: a suppressed tool explains the required profile",
  toolDecision("discovery", "shell_run").reason.includes('"developer"'),
  toolDecision("discovery", "shell_run").reason);
check("decision: an allowed tool says so", toolDecision("developer", "shell_run").allowed);
throws("decision: an undeclared tool is refused", () => isToolAllowed("full", "rm_rf_everything"), "not declared");
check("spec: lookup finds a declared tool", specFor("shell_run")?.minProfile === "developer");
check("spec: lookup returns undefined for an unknown tool", specFor("nope") === undefined);

// ---------------------------------------------------------------- repo-local runtime restart
{
  const a = runtimeRestartInvocation("A");
  const b = runtimeRestartInvocation("B");
  check("runtime-restart: uses PowerShell", a.executable === "powershell.exe", a.executable);
  check(
    "runtime-restart: uses repo-local request script",
    a.args.some((arg) => /request-restart-runtime-slot\.ps1$/i.test(arg)),
    a.args.join(" ")
  );
  check(
    "runtime-restart: slot A is fixed",
    a.args.includes("-Slot") && a.args.includes("A"),
    a.args.join(" ")
  );
  check(
    "runtime-restart: slot B is fixed",
    b.args.includes("-Slot") && b.args.includes("B"),
    b.args.join(" ")
  );
  check(
    "runtime-restart: does not invoke Task Scheduler or RestartBroker",
    !/schtasks|RestartBroker/i.test(a.args.join(" ")) &&
      !/schtasks|RestartBroker/i.test(b.args.join(" ")),
    [a.args.join(" "), b.args.join(" ")].join(" | ")
  );
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const testRepo = path.resolve(testDir, "..", "..");
  const hostTaskInstaller = await readFile(
    path.join(testRepo, "scripts", "deployment", "install-host-tasks.ps1"),
    "utf8"
  );
  check(
    "deployment: host task installer does not provision RestartBroker",
    !/P05-RestartBroker|P05_OPERATOR_RESTART_TASK|restartTask|restartName/.test(hostTaskInstaller)
  );
  throws(
    "runtime-restart: invalid slot is refused",
    () => runtimeRestartInvocation("C"),
    "must be A or B"
  );
}

// ---------------------------------------------------------------- dangerous commands
process.env.REMOTE_AGENT_ALLOWED_ROOTS = process.platform === "win32" ? "C:\\p05-root" : "/srv/project_git";
const { assertAllowedPath, assertPathShape, assertSafeCommand, protectionReason } = await import("../security.js");

for (const command of ["format C:", "diskpart", "shutdown /r", "reg add HKLM\\Software", "Remove-Item -Recurse -Force C:\\Data", "rm -rf /"]) {
  throws(`command: "${command}" is denied`, () => assertSafeCommand(command), "blocked by safety policy");
}
check("command: an ordinary read command passes", (() => { assertSafeCommand("git status"); return true; })());

// ---------------------------------------------------------------- allowed-root configuration fails closed
const { parseAllowedRoots, parseDefaultCwd, readOwnEnv } = await import("../config.js");
const absRoot = process.platform === "win32" ? "C:\\p05-root" : "/srv/project_git";
const absOther = process.platform === "win32" ? "C:\\Windows" : "/etc";
const absChild = [absRoot, "sub"].join(process.platform === "win32" ? "\\" : "/");

// No machine-specific default: an unset variable is a configuration error, exactly like
// an empty one. A built-in root would name one developer's drive on every machine.
throws("config: unset roots are refused (no machine-specific default)",
  () => parseAllowedRoots(undefined), "no default root");
check("config: a single root is accepted", parseAllowedRoots(absRoot).length === 1);
check("config: several roots are accepted", parseAllowedRoots(`${absRoot};${absOther}`).length === 2);
throws("config: empty roots are refused", () => parseAllowedRoots(""), "no usable path");
throws("config: a separator-only value is refused", () => parseAllowedRoots(";"), "no usable path");
throws("config: a blank value is refused", () => parseAllowedRoots("   "), "no usable path");
throws("config: a relative root is refused", () => parseAllowedRoots("Project_Git"), "must be absolute");
// Unset, empty and whitespace-only all mean "the first authorised root". That cannot
// widen access - the root list is explicit and required - and it is the documented
// install path, since .env.example ships this line blank.
check("config: an unset default cwd uses the first root", parseDefaultCwd(undefined, [absRoot]) === absRoot);
check("config: an empty default cwd uses the first root", parseDefaultCwd("", [absRoot]) === absRoot);
check("config: a whitespace default cwd uses the first root", parseDefaultCwd("   ", [absRoot]) === absRoot);
check("config: a default cwd is trimmed before use", parseDefaultCwd(`  ${absChild}  `, [absRoot]) === absChild);
check("config: an in-root cwd is accepted", parseDefaultCwd(absChild, [absRoot]) === absChild);
throws("config: a separators-only cwd is refused", () => parseDefaultCwd(";", [absRoot]), "no usable path");
throws("config: a cwd outside the roots is refused", () => parseDefaultCwd(absOther, [absRoot]), "outside the allowed roots");

// process.env inherits from Object.prototype, so a plain lookup can answer for a variable
// that was never set - and these variables pick the roots and the profile.
(Object.prototype as Record<string, unknown>).P05_TEST_POLLUTED = "1";
check("config: a plain lookup sees the inherited value", (process.env as Record<string, string>)["P05_TEST_POLLUTED"] === "1");
check("config: readOwnEnv ignores inherited properties", readOwnEnv("P05_TEST_POLLUTED") === undefined);
delete (Object.prototype as Record<string, unknown>).P05_TEST_POLLUTED;
check("config: readOwnEnv still reads real variables", readOwnEnv("REMOTE_AGENT_ALLOWED_ROOTS") === process.env.REMOTE_AGENT_ALLOWED_ROOTS);

// ---------------------------------------------------------------- write-side code-execution paths
const { writeProtectionReason } = await import("../security.js");
const wp = (...parts: string[]) => [absRoot, ...parts].join(process.platform === "win32" ? "\\" : "/");
for (const rel of [
  ["node_modules", "pkg", "index.js"],
  ["dist", "index.js"],
  [".vscode", "tasks.json"],
  ["package.json"],
  ["package-lock.json"],
  ["tsconfig.json"],
  [".mcp.json"],
  [".gitmodules"]
]) {
  check(`write-protect: ${rel.join("/")} cannot be written`,
    Boolean(writeProtectionReason(wp(...rel))), String(writeProtectionReason(wp(...rel))));
}
for (const rel of [["src", "index.ts"], ["README.md"], ["docs", "architecture", "TOOL-PROFILES.md"]]) {
  check(`write-protect: ${rel.join("/")} stays writable`, writeProtectionReason(wp(...rel)) === undefined);
}

// ---------------------------------------------------------------- profile partition invariant
for (const profile of TOOL_PROFILE_NAMES) {
  const report = toolProfileReport(profile, "env");
  sameSet(`partition: ${profile} exposed + suppressed covers every declared tool`,
    [...report.exposed, ...report.suppressed.map((entry) => entry.tool)], TOOL_SPECS.map((spec) => spec.name));
  check(`partition: ${profile} never reports a tool twice`,
    new Set([...report.exposed, ...report.suppressed.map((entry) => entry.tool)]).size === TOOL_SPECS.length);
}

// ---------------------------------------------------------------- protected paths
const root = process.platform === "win32" ? "C:\\p05-root" : "/srv/project_git";
const p = (...parts: string[]) => [root, ...parts].join(process.platform === "win32" ? "\\" : "/");

check("path: ordinary source file is unprotected", protectionReason(p("P05_Remote_Agent", "src", "index.ts")) === undefined);
check("path: allowed root accepts an in-tree file", Boolean(assertAllowedPath(p("P05_Remote_Agent", "src", "index.ts"))));
throws("path: allowed root escape is denied",
  () => assertAllowedPath(process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts"),
  "outside the allowed roots");

check("path: .env is protected", Boolean(protectionReason(p("P05_Remote_Agent", ".env"))?.includes("secrets")));
check("path: .env.local is protected", Boolean(protectionReason(p("P05_Remote_Agent", ".env.local"))?.includes("secrets")));
check("path: trailing dot on .env does not evade", Boolean(protectionReason(p("P05_Remote_Agent", ".env."))?.includes("secrets")));
check("path: .env.example template stays readable", protectionReason(p("P05_Remote_Agent", ".env.example")) === undefined);
check("path: .env.sample template stays readable", protectionReason(p("P05_Remote_Agent", ".env.sample")) === undefined);
check("path: .git segment is protected", Boolean(protectionReason(p("P05_Remote_Agent", ".git", "config"))?.includes("protected")));
check("path: trailing dot on .git does not evade", Boolean(protectionReason(p("P05_Remote_Agent", ".git.", "hooks"))?.includes("protected")));
check("path: trailing space on .git does not evade", Boolean(protectionReason(p("P05_Remote_Agent", ".git ", "hooks"))?.includes("protected")));
check("path: nested .git is caught", Boolean(protectionReason(p("other-repo", ".git", "config"))?.includes("protected")));
check("path: .p05 state is protected", Boolean(protectionReason(p("P05_Remote_Agent", ".p05", "device.json"))?.includes("protected")));
check("path: .npmrc is protected", Boolean(protectionReason(p("P05_Remote_Agent", ".npmrc"))?.includes("secrets")));
check("path: private key is protected", Boolean(protectionReason(p("certs", "server.pem"))?.includes("private keys")));
check("path: an ordinary dotted filename is not over-blocked", protectionReason(p("P05_Remote_Agent", "docs", "v1.2.3.md")) === undefined);

// Windows spellings that change which file is touched while looking harmless.
throws("path: alternate data stream is refused", () => assertPathShape("C:\\a\\b.txt:evil", "write"), "alternate data streams");
throws("path: extended-length prefix is refused", () => assertPathShape("\\\\?\\C:\\p05-root\\x", "read"), "UNC");
throws("path: UNC share is refused", () => assertPathShape("\\\\server\\share\\x", "read"), "UNC");
throws("path: drive-relative path is refused", () => assertPathShape("C:foo", "read"), "drive-relative");
check("path: an ordinary absolute path is accepted", Boolean(assertPathShape("C:\\p05-root\\x", "read")));

// ---------------------------------------------------------------- version consistency
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(path.resolve(here, "..", "..", "package.json"), "utf8")) as { version?: string };
  const { VERSION } = await import("../version.js");
  check("version: package.json agrees with src/version.ts", pkg.version === VERSION,
    `package.json ${pkg.version} vs src/version.ts ${VERSION}`);
  check("version: the version is a plain semver string", /^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
}

console.log(`POLICY_PROFILES_OK (${checks} checks)`);