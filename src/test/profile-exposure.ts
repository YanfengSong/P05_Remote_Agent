/**
 * Tool profile exposure end-to-end check.
 *
 * Spawns the real server over stdio for each profile and asserts what a remote client
 * actually sees in tools/list, that suppressed tools are genuinely uncallable, and
 * that the path guards hold on the real filesystem.
 *
 * Run: npm run test:exposure
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "index.js");

const ROOT = "F:\\Project_Git";
const REPO = path.join(ROOT, "P05_Remote_Agent");
const PROBE_DIR = path.join(ROOT, "_p05_profile_probe");
const STATE_DIR = path.join(REPO, ".p05");

const DISCOVERY_TOOLS = ["device_info", "ping"];
const READONLY_TOOLS = [...DISCOVERY_TOOLS, "fs_list", "fs_read"];
const DEVELOPER_TOOLS = [...READONLY_TOOLS, "fs_write", "mcp_call_tool", "mcp_list_tools", "mcp_status"];
const FULL_TOOLS = [...DEVELOPER_TOOLS, "shell_run"];
const ALL_TOOLS = FULL_TOOLS;

let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function sameSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  check(label, a === e, `expected [${e}] got [${a}]`);
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_")) env[key] = value;
  }
  env.REMOTE_AGENT_ALLOWED_ROOTS = ROOT;
  env.REMOTE_AGENT_DEFAULT_CWD = ROOT;
  env.P05_STATE_DIR = STATE_DIR;
  return { ...env, ...extra };
}

type Session = {
  client: Client;
  stderrText: () => string;
};

async function openSession(env: Record<string, string>): Promise<Session> {
  const client = new Client({ name: "p05-profile-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
    stderr: "pipe"
  });
  const chunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  await client.connect(transport);
  return { client, stderrText: () => chunks.join("") };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

/**
 * A refused operation shows up in two shapes: the SDK turns a thrown handler error
 * into a CallToolResult with isError, while an unregistered tool raises a JSON-RPC
 * error that makes callTool throw. Treat both as failure.
 */
async function outcome(fn: () => Promise<unknown>): Promise<{ failed: boolean; message: string }> {
  try {
    const result = await fn();
    return { failed: Boolean((result as { isError?: boolean })?.isError), message: textOf(result) };
  } catch (error) {
    return { failed: true, message: error instanceof Error ? error.message : String(error) };
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- profile surfaces
type Scenario = {
  label: string;
  env: Record<string, string>;
  profile: string;
  expected: readonly string[];
};

const scenarios: Scenario[] = [
  { label: "no env at all (default)", env: {}, profile: "discovery", expected: DISCOVERY_TOOLS },
  { label: "discovery", env: { P05_TOOL_PROFILE: "discovery" }, profile: "discovery", expected: DISCOVERY_TOOLS },
  { label: "readonly", env: { P05_TOOL_PROFILE: "readonly" }, profile: "readonly", expected: READONLY_TOOLS },
  { label: "developer", env: { P05_TOOL_PROFILE: "developer" }, profile: "developer", expected: DEVELOPER_TOOLS },
  { label: "full", env: { P05_TOOL_PROFILE: "full" }, profile: "full", expected: FULL_TOOLS }
];

for (const scenario of scenarios) {
  const session = await openSession(childEnv(scenario.env));
  try {
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name);
    sameSet(`[${scenario.label}] tools/list`, names, scenario.expected);

    const reportLine = session.stderrText().split(/\r?\n/).find((line) => line.includes("p05.tool_profile"));
    check(`[${scenario.label}] startup exposure report is emitted on stderr`, Boolean(reportLine));
    const report = JSON.parse(reportLine!) as { profile: string; exposed: string[]; suppressed: { tool: string }[] };
    check(`[${scenario.label}] report carries the active profile`, report.profile === scenario.profile, report.profile);
    sameSet(`[${scenario.label}] report exposed list matches tools/list`, report.exposed, names);
    // Regression guard: every declared tool is accounted for by the report, so no tool can
    // be registered without going through the profile gate.
    sameSet(`[${scenario.label}] exposed + suppressed covers every declared tool`,
      [...report.exposed, ...report.suppressed.map((entry) => entry.tool)], ALL_TOOLS);

    // Every suppressed tool must be genuinely unreachable, not merely hidden.
    for (const name of ALL_TOOLS.filter((tool) => !scenario.expected.includes(tool))) {
      const call = await outcome(() =>
        session.client.callTool({ name, arguments: { path: "x", content: "", server: "matlab", tool: "evaluate" } })
      );
      check(`[${scenario.label}] calling suppressed ${name} is rejected`, call.failed, call.message.slice(0, 120));
    }

    // A tool dropped from the profile model entirely must be gone too.
    const policyInfo = await outcome(() => session.client.callTool({ name: "policy_info", arguments: {} }));
    check(`[${scenario.label}] policy_info is not part of any profile`, policyInfo.failed);
  } finally {
    await session.client.close().catch(() => undefined);
  }
  console.log(`ok  ${scenario.label} -> [${[...scenario.expected].sort().join(", ")}]`);
}

// ---------------------------------------------------------------- TASK-001 DoD, verbatim
{
  const session = await openSession(childEnv({ P05_TOOL_PROFILE: "discovery" }));
  try {
    const { tools } = await session.client.listTools();
    sameSet("DoD: P05_TOOL_PROFILE=discovery returns device_info + ping only", tools.map((t) => t.name), ["device_info", "ping"]);
    for (const forbidden of ["shell_run", "fs_write", "mcp_call_tool"]) {
      check(`DoD: discovery must NOT expose ${forbidden}`, !tools.some((tool) => tool.name === forbidden));
    }
    const ping = await session.client.callTool({ name: "ping", arguments: {} });
    check("DoD: discovery can still answer ping", textOf(ping).includes('"ok"'), textOf(ping).slice(0, 120));
  } finally {
    await session.client.close().catch(() => undefined);
  }
  console.log("ok  TASK-001 DoD (discovery exposes device_info + ping only)");
}

// ---------------------------------------------------------------- device identity stability
{
  const identityPath = path.join(STATE_DIR, "device.json");
  const before = await fs.readFile(identityPath, "utf8");
  const storedId = (JSON.parse(before) as { deviceId: string }).deviceId;

  const session = await openSession(childEnv({ P05_TOOL_PROFILE: "discovery" }));
  try {
    const info = JSON.parse(textOf(await session.client.callTool({ name: "device_info", arguments: {} }))) as { deviceId: string };
    check("device_id: reported id matches the stored identity", info.deviceId === storedId, `${info.deviceId} != ${storedId}`);
  } finally {
    await session.client.close().catch(() => undefined);
  }
  check("device_id: identity file is unchanged by a server start", (await fs.readFile(identityPath, "utf8")) === before);
  console.log(`ok  device_id stable (${storedId.slice(0, 12)}...)`);
}

// ---------------------------------------------------------------- write + real filesystem guards
{
  const session = await openSession(childEnv({ P05_TOOL_PROFILE: "developer" }));
  const outsideTarget = path.join(path.parse(ROOT).root, "_p05_junction_target");
  const outsideName = "_p05_junction_target";
  const outlink = path.join(ROOT, "_p05_junction_probe");
  const gitlink = path.join(ROOT, "_p05_git_junction");
  const goneJunction = path.join(ROOT, "_p05_gone_junction");
  const goneTarget = path.join(path.parse(ROOT).root, "_p05_never_exists");
  const gitDir = path.join(REPO, ".git");

  const mklink = (link: string, target: string) => execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
  // rmdir (not rm -r) removes the reparse point only; a recursive delete would walk into the target.
  const unlink = (link: string) => { try { execFileSync("cmd", ["/c", "rmdir", link], { stdio: "pipe" }); } catch { /* not present */ } };
  const shortPathOf = (target: string): string => {
    try {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-Command",
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${target}').ShortPath`
      ]).toString().trim();
    } catch {
      return "";
    }
  };

  try {
    unlink(outlink);
    unlink(gitlink);
    await fs.rm(outsideTarget, { recursive: true, force: true });
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.writeFile(path.join(outsideTarget, "outside.txt"), "outside-root", "utf8");

    // baseline write works at developer
    await fs.mkdir(PROBE_DIR, { recursive: true });
    const probe = path.join(PROBE_DIR, "probe.txt");
    await session.client.callTool({ name: "fs_write", arguments: { path: probe, content: "p05-probe" } });
    const readBack = await session.client.callTool({ name: "fs_read", arguments: { path: probe } });
    check("developer: fs_write round-trips through fs_read", textOf(readBack).includes("p05-probe"), textOf(readBack));

    // 1. a junction inside the allowed root that points outside it
    mklink(outlink, outsideTarget);
    const readOut = await outcome(() =>
      session.client.callTool({ name: "fs_read", arguments: { path: path.join(outlink, "outside.txt") } })
    );
    check("junction: read through a link leaving the allowed root is refused",
      readOut.failed && readOut.message.includes("a link resolves outside the allowed roots"), readOut.message.slice(0, 200));
    const writeOut = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(outlink, "planted.txt"), content: "x" } })
    );
    check("junction: write through a link leaving the allowed root is refused", writeOut.failed, writeOut.message.slice(0, 200));
    check("junction: nothing was planted outside the root", !(await pathExists(path.join(outsideTarget, "planted.txt"))));

    // 2. a junction inside the allowed root that lands on a protected path
    mklink(gitlink, gitDir);
    const writeGit = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(gitlink, "hooks", "pre-commit"), content: "x" } })
    );
    check("junction: write through a link landing on .git is refused", writeGit.failed, writeGit.message.slice(0, 200));

    // 3. trailing dot on the .git segment
    const dottedResult = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(REPO, ".git.", "hooks", "pre-commit"), content: "x" } })
    );
    check("trailing-dot .git spelling is refused", dottedResult.failed, dottedResult.message.slice(0, 200));
    check("trailing-dot write created no hook file", !(await pathExists(path.join(gitDir, "hooks", "pre-commit"))));

    // 4. plain .git write
    const plainGit = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(gitDir, "hooks", "pre-commit"), content: "x" } })
    );
    check(".git/hooks write is refused", plainGit.failed && plainGit.message.includes("refused"), plainGit.message.slice(0, 200));

    // 5. alternate data stream + extended-length prefix
    const adsResult = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(PROBE_DIR, "probe.txt:evil"), content: "x" } })
    );
    check("alternate data stream is refused", adsResult.failed, adsResult.message.slice(0, 200));
    const extendedResult = await outcome(() =>
      session.client.callTool({ name: "fs_read", arguments: { path: "\\\\?\\" + path.join(REPO, "README.md") } })
    );
    check("extended-length path prefix is refused", extendedResult.failed, extendedResult.message.slice(0, 200));

    // 6. a dangling junction: its target does not exist, so realpath fails. Falling back
    //    to the unresolved path here would skip the containment check entirely.
    mklink(goneJunction, goneTarget);
    const danglingRead = await outcome(() =>
      session.client.callTool({ name: "fs_read", arguments: { path: path.join(goneJunction, "x.txt") } })
    );
    check("dangling junction: read is refused", danglingRead.failed && danglingRead.message.includes("does not exist"),
      danglingRead.message.slice(0, 200));
    const danglingWrite = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(goneJunction, "sub", "x.txt"), content: "x" } })
    );
    check("dangling junction: write is refused", danglingWrite.failed, danglingWrite.message.slice(0, 200));
    check("dangling junction: nothing was created at the target", !(await pathExists(goneTarget)));

    // 7. write-side code-execution paths: writing these would run code on the next start
    const packageJsonPath = path.join(REPO, "package.json");
    const packageJsonBefore = await fs.readFile(packageJsonPath, "utf8");
    for (const rel of [
      ["node_modules", "_p05_probe.js"],
      ["dist", "_p05_probe.js"],
      ["package.json"],
      ["tsconfig.json"],
      [".vscode", "tasks.json"]
    ]) {
      const target = path.join(REPO, ...rel);
      const attempt = await outcome(() => session.client.callTool({ name: "fs_write", arguments: { path: target, content: "x" } }));
      check(`write side: ${rel.join("/")} is refused`, attempt.failed, attempt.message.slice(0, 200));
    }
    check("write side: package.json was not modified", (await fs.readFile(packageJsonPath, "utf8")) === packageJsonBefore);
    check("write side: nothing landed in dist", !(await pathExists(path.join(REPO, "dist", "_p05_probe.js"))));
    check("write side: nothing landed in node_modules", !(await pathExists(path.join(REPO, "node_modules", "_p05_probe.js"))));

    // 8. refusals must not hand the remote the machine's layout
    check("leak: a link refusal does not name the link target", !readOut.message.includes(outsideName), readOut.message.slice(0, 200));
    const relativeRead = await outcome(() => session.client.callTool({ name: "fs_read", arguments: { path: "definitely-not-here.txt" } }));
    check("leak: a missing-file error does not reveal the working directory",
      relativeRead.failed && !relativeRead.message.includes(REPO), relativeRead.message.slice(0, 200));
    const outsideRead = await outcome(() => session.client.callTool({ name: "fs_read", arguments: { path: path.join(path.parse(ROOT).root, "Windows", "win.ini") } }));
    check("leak: an out-of-root refusal states the rule, not the allowed roots",
      outsideRead.failed && !outsideRead.message.includes(ROOT), outsideRead.message.slice(0, 200));

    // 9. .env is never handed out
    const envRead = await outcome(() => session.client.callTool({ name: "fs_read", arguments: { path: path.join(REPO, ".env") } }));
    check("fs_read refuses to hand out .env", envRead.failed, envRead.message.slice(0, 200));

    // 10. short (8.3) name for .git, when the volume generates them
    const shortGit = shortPathOf(gitDir);
    const shortBase = shortGit ? path.basename(shortGit) : "";
    if (shortBase && shortBase !== ".git") {
      const shortResult = await outcome(() =>
        session.client.callTool({ name: "fs_write", arguments: { path: path.join(path.dirname(shortGit), shortBase, "hooks", "pre-commit"), content: "x" } })
      );
      check(`short-name ${shortBase} spelling is refused`, shortResult.failed, shortResult.message.slice(0, 200));
      console.log(`ok  short-name probe used "${shortBase}" for .git`);
    } else {
      console.log("note  8.3 short names are unavailable on this volume; short-name probe skipped");
    }
  } finally {
    unlink(outlink);
    unlink(gitlink);
    unlink(goneJunction);
    check("junction cleanup left the link target intact", await pathExists(path.join(outsideTarget, "outside.txt")));
    await fs.rm(outsideTarget, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(PROBE_DIR, { recursive: true, force: true }).catch(() => undefined);
    await session.client.close().catch(() => undefined);
  }
  console.log("ok  developer write + path guards");
}

// ---------------------------------------------------------------- full-profile shell
{
  const session = await openSession(childEnv({ P05_TOOL_PROFILE: "full" }));
  const escapeLink = path.join(ROOT, "_p05_shell_junction");
  const escapeTarget = path.join(path.parse(ROOT).root, "_p05_shell_target");
  try {
    const shell = await session.client.callTool({ name: "shell_run", arguments: { command: "Write-Output p05-shell-ok", cwd: ROOT } });
    check("full: shell_run executes", textOf(shell).includes("p05-shell-ok"), textOf(shell).slice(0, 200));

    // cwd used to be string-checked only, so a junction in the root ran the command outside it.
    await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(escapeTarget, { recursive: true });
    try { execFileSync("cmd", ["/c", "rmdir", escapeLink], { stdio: "pipe" }); } catch { /* not present */ }
    execFileSync("cmd", ["/c", "mklink", "/J", escapeLink, escapeTarget], { stdio: "pipe" });

    const escapedCwd = await outcome(() =>
      session.client.callTool({ name: "shell_run", arguments: { command: "New-Item -ItemType File -Name escaped.txt -Force", cwd: escapeLink } })
    );
    check("full: shell_run refuses a cwd that is a link out of the roots", escapedCwd.failed, escapedCwd.message.slice(0, 200));
    check("full: nothing was written outside the roots by shell_run", !(await pathExists(path.join(escapeTarget, "escaped.txt"))));
  } finally {
    try { execFileSync("cmd", ["/c", "rmdir", escapeLink], { stdio: "pipe" }); } catch { /* not present */ }
    await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => undefined);
    await session.client.close().catch(() => undefined);
  }
  console.log("ok  full grants shell_run, and its cwd goes through the same guard");
}

// ---------------------------------------------------------------- fail closed
async function spawnExpectingFailure(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverEntry], { env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

{
  const failure = await spawnExpectingFailure(childEnv({ P05_TOOL_PROFILE: "godmode" }));
  check("unknown profile exits non-zero", failure.code !== 0, `exit code ${failure.code}`);
  check("unknown profile explains itself on stderr", failure.stderr.includes("Unknown P05_TOOL_PROFILE"), failure.stderr.split(/\r?\n/)[0]);
}

{
  const env = childEnv({});
  env.REMOTE_AGENT_ALLOWED_ROOTS = "";
  const failure = await spawnExpectingFailure(env);
  check("an explicitly empty allowed-roots value exits non-zero", failure.code !== 0, `exit code ${failure.code}`);
  check("empty allowed roots explains itself on stderr", failure.stderr.includes("no usable path"), failure.stderr.split(/\r?\n/)[0]);
  console.log("ok  fail closed on empty allowed roots (copying .env.example verbatim will not start)");
}

{
  const env = childEnv({});
  env.REMOTE_AGENT_DEFAULT_CWD = path.parse(ROOT).root;
  const failure = await spawnExpectingFailure(env);
  check("a default cwd outside the allowed roots exits non-zero", failure.code !== 0, `exit code ${failure.code}`);
  check("out-of-root cwd explains itself on stderr", failure.stderr.includes("outside the allowed roots"), failure.stderr.split(/\r?\n/)[0]);
}

console.log(`PROFILE_EXPOSURE_OK (${checks} checks)`);
