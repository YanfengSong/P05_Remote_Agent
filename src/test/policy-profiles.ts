/**
 * Tool profile policy checks. No MCP transport involved: this exercises the profile
 * matrix, the catalog invariants and the path/command guards directly.
 *
 * Run: npm run test:policy
 */
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
const READONLY_TOOLS = [...DISCOVERY_TOOLS, "fs_read", "fs_list"];
const DEVELOPER_TOOLS = [...READONLY_TOOLS, "fs_write", "mcp_call_tool", "mcp_list_tools", "mcp_status"];
const FULL_TOOLS = [...DEVELOPER_TOOLS, "shell_run"];

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
  toolDecision("discovery", "shell_run").reason.includes('"full"'),
  toolDecision("discovery", "shell_run").reason);
check("decision: an allowed tool says so", toolDecision("full", "shell_run").allowed);
throws("decision: an undeclared tool is refused", () => isToolAllowed("full", "rm_rf_everything"), "not declared");
check("spec: lookup finds a declared tool", specFor("shell_run")?.minProfile === "full");
check("spec: lookup returns undefined for an unknown tool", specFor("nope") === undefined);

// ---------------------------------------------------------------- dangerous commands
process.env.REMOTE_AGENT_ALLOWED_ROOTS = process.platform === "win32" ? "D:\\Project_Git" : "/srv/project_git";
const { assertAllowedPath, assertPathShape, assertSafeCommand, protectionReason } = await import("../security.js");

for (const command of ["format C:", "diskpart", "shutdown /r", "reg add HKLM\\Software", "Remove-Item -Recurse -Force C:\\Data", "rm -rf /"]) {
  throws(`command: "${command}" is denied`, () => assertSafeCommand(command), "blocked by safety policy");
}
check("command: an ordinary read command passes", (() => { assertSafeCommand("git status"); return true; })());

// ---------------------------------------------------------------- allowed-root configuration fails closed
const { parseAllowedRoots, parseDefaultCwd } = await import("../config.js");
const absRoot = process.platform === "win32" ? "F:\\Project_Git" : "/srv/project_git";
const absOther = process.platform === "win32" ? "C:\\Windows" : "/etc";
const absChild = [absRoot, "sub"].join(process.platform === "win32" ? "\\" : "/");

check("config: unset roots fall back to one default root", parseAllowedRoots(undefined).length === 1);
check("config: a single root is accepted", parseAllowedRoots(absRoot).length === 1);
check("config: several roots are accepted", parseAllowedRoots(`${absRoot};${absOther}`).length === 2);
throws("config: empty roots are refused", () => parseAllowedRoots(""), "no usable path");
throws("config: a separator-only value is refused", () => parseAllowedRoots(";"), "no usable path");
throws("config: a blank value is refused", () => parseAllowedRoots("   "), "no usable path");
throws("config: a relative root is refused", () => parseAllowedRoots("Project_Git"), "must be absolute");
check("config: an unset default cwd uses the first root", parseDefaultCwd(undefined, [absRoot]) === absRoot);
check("config: an in-root cwd is accepted", parseDefaultCwd(absChild, [absRoot]) === absChild);
throws("config: an empty cwd is refused", () => parseDefaultCwd("", [absRoot]), "empty");
throws("config: a cwd outside the roots is refused", () => parseDefaultCwd(absOther, [absRoot]), "outside the allowed roots");

// ---------------------------------------------------------------- protected paths
const root = process.platform === "win32" ? "D:\\Project_Git" : "/srv/project_git";
const p = (...parts: string[]) => [root, ...parts].join(process.platform === "win32" ? "\\" : "/");

check("path: ordinary source file is unprotected", protectionReason(p("P05_Remote_Agent", "src", "index.ts")) === undefined);
check("path: allowed root accepts an in-tree file", Boolean(assertAllowedPath(p("P05_Remote_Agent", "src", "index.ts"))));
throws("path: allowed root escape is denied",
  () => assertAllowedPath(process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts"),
  "outside allowed roots");

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
throws("path: alternate data stream is refused", () => assertPathShape("F:\\a\\b.txt:evil", "write"), "alternate data streams");
throws("path: extended-length prefix is refused", () => assertPathShape("\\\\?\\F:\\Project_Git\\x", "read"), "UNC");
throws("path: UNC share is refused", () => assertPathShape("\\\\server\\share\\x", "read"), "UNC");
throws("path: drive-relative path is refused", () => assertPathShape("F:foo", "read"), "drive-relative");
check("path: an ordinary absolute path is accepted", Boolean(assertPathShape("F:\\Project_Git\\x", "read")));

console.log(`POLICY_PROFILES_OK (${checks} checks)`);
