/**
 * Tool-profile exposure end-to-end check.
 *
 * Spawns the real server over stdio for each profile combination and asserts what
 * a remote client actually sees in tools/list — and that every suppressed tool is
 * genuinely uncallable. This is the acceptance test for the P05_TOOL_PROFILE gate.
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
const PROBE_DIR = path.join(ROOT, "_p05_profile_probe");

const SAFE_SET = ["device_info", "fs_list", "fs_read", "ping", "policy_info"];
const DEV_SET = [...SAFE_SET, "mcp_list_tools", "mcp_status"];
const ALL_SET = [...DEV_SET, "fs_write", "mcp_call_tool", "shell_run"];

let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function sameSet(label: string, actual: string[], expected: string[]): void {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  check(label, a === e, `expected [${e}] got [${a}]`);
}

const UNLOCK_KEYS = ["P05_ENABLE_FS_WRITE", "P05_ENABLE_SHELL", "P05_ENABLE_DOWNSTREAM_EXEC"];

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && orderSafe(key)) env[key] = value;
  }
  delete env.P05_TOOL_PROFILE;
  for (const key of UNLOCK_KEYS) delete env[key];
  env.REMOTE_AGENT_ALLOWED_ROOTS = ROOT;
  env.REMOTE_AGENT_DEFAULT_CWD = ROOT;
  return { ...env, ...extra };
}

function orderSafe(key: string): boolean {
  return !key.startsWith("P05_");
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

type Scenario = {
  label: string;
  env: Record<string, string>;
  profile: string;
  expected: string[];
};

const scenarios: Scenario[] = [
  {
    label: "no env at all (default)",
    env: {},
    profile: "safe",
    expected: SAFE_SET
  },
  {
    label: "explicit safe",
    env: { P05_TOOL_PROFILE: "safe" },
    profile: "safe",
    expected: SAFE_SET
  },
  {
    label: "dev, no unlocks",
    env: { P05_TOOL_PROFILE: "dev" },
    profile: "dev",
    expected: DEV_SET
  },
  {
    label: "dev + fs_write unlock",
    env: { P05_TOOL_PROFILE: "dev", P05_ENABLE_FS_WRITE: "1" },
    profile: "dev",
    expected: [...DEV_SET, "fs_write"]
  },
  {
    label: "full, no unlocks (escalation alone must grant nothing dangerous)",
    env: { P05_TOOL_PROFILE: "full" },
    profile: "full",
    expected: DEV_SET
  },
  {
    label: "full + every unlock + unlock flag without profile",
    env: {
      P05_TOOL_PROFILE: "full",
      P05_ENABLE_FS_WRITE: "1",
      P05_ENABLE_SHELL: "1",
      P05_ENABLE_DOWNSTREAM_EXEC: "1"
    },
    profile: "full",
    expected: ALL_SET
  }
];

for (const scenario of scenarios) {
  const session = await openSession(childEnv(scenario.env));
  try {
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name);
    sameSet(`[${scenario.label}] tools/list`, names, scenario.expected);

    const reportLine = session
      .stderrText()
      .split(/\r?\n/)
      .find((line) => line.includes("p05.tool_profile"));
    check(`[${scenario.label}] startup exposure report is emitted on stderr`, Boolean(reportLine));
    const report = JSON.parse(reportLine!) as { profile: string; exposed: string[] };
    check(`[${scenario.label}] report carries the active profile`, report.profile === scenario.profile, report.profile);
    sameSet(`[${scenario.label}] report exposed list matches tools/list`, report.exposed, names);

    // policy_info must agree with reality
    const policy = JSON.parse(textOf(await session.client.callTool({ name: "policy_info", arguments: {} }))) as {
      profile: string;
      exposed: string[];
      suppressed: { tool: string; reason: string }[];
    };
    check(`[${scenario.label}] policy_info profile`, policy.profile === scenario.profile, policy.profile);
    sameSet(`[${scenario.label}] policy_info exposed`, policy.exposed, scenario.expected);

    // Every suppressed tool must be genuinely unreachable, not merely hidden.
    const suppressed = ALL_SET.concat("policy_info", "device_info", "ping")
      .filter((name) => !scenario.expected.includes(name));
    for (const name of suppressed) {
      const reason = policy.suppressed.find((entry) => entry.tool === name)?.reason;
      check(`[${scenario.label}] suppressed ${name} states a reason`, Boolean(reason), reason);
      const call = await outcome(() =>
        session.client.callTool({ name, arguments: { path: "x", content: "", server: "matlab", tool: "evaluate" } })
      );
      check(`[${scenario.label}] calling suppressed ${name} is rejected`, call.failed, call.message.slice(0, 120));
    }
  } finally {
    await session.client.close().catch(() => undefined);
  }
  console.log(`ok  ${scenario.label} -> [${scenario.expected.sort().join(", ")}]`);
}

// ---------------------------------------------------------------- double-key proof
{
  const session = await openSession(childEnv({
    P05_TOOL_PROFILE: "full",
    P05_ENABLE_FS_WRITE: "1",
    P05_ENABLE_SHELL: "1"
  }));
  try {
    const shell = await session.client.callTool({
      name: "shell_run",
      arguments: { command: "Write-Output p05-shell-ok", cwd: ROOT }
    });
    check("unlocked shell_run actually executes", textOf(shell).includes("p05-shell-ok"), textOf(shell));

    await fs.mkdir(PROBE_DIR, { recursive: true });
    const probe = path.join(PROBE_DIR, "probe.txt");
    await session.client.callTool({ name: "fs_write", arguments: { path: probe, content: "p05-probe" } });
    const readBack = await session.client.callTool({ name: "fs_read", arguments: { path: probe } });
    check("unlocked fs_write round-trips", textOf(readBack).includes("p05-probe"), textOf(readBack));

    const hookPath = path.join(ROOT, "P05_Remote_Agent", ".git", "hooks", "pre-commit");
    const hookExistedBefore = await pathExists(hookPath);
    const hookWrite = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: hookPath, content: "x" } })
    );
    check(
      "fs_write refuses the .git/hooks code-execution vector",
      hookWrite.failed && hookWrite.message.includes("refused"),
      hookWrite.message.slice(0, 200)
    );
    check(
      "fs_write did not create the hook file",
      (await pathExists(hookPath)) === hookExistedBefore,
      `existence changed: ${hookExistedBefore} -> ${await pathExists(hookPath)}`
    );

    const envRead = await outcome(() =>
      session.client.callTool({ name: "fs_read", arguments: { path: path.join(ROOT, "P05_Remote_Agent", ".env") } })
    );
    check("fs_read refuses to hand out .env", envRead.failed, envRead.message.slice(0, 200));
  } finally {
    await session.client.close().catch(() => undefined);
    await fs.rm(PROBE_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- path hardening on the real filesystem
{
  const session = await openSession(childEnv({ P05_TOOL_PROFILE: "full", P05_ENABLE_FS_WRITE: "1" }));
  const outsideTarget = path.join(path.parse(ROOT).root, "_p05_junction_target");
  const outlink = path.join(ROOT, "_p05_junction_probe");
  const gitlink = path.join(ROOT, "_p05_git_junction");
  const gitDir = path.join(ROOT, "P05_Remote_Agent", ".git");

  const mklink = (link: string, target: string) => execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
  // rmdir (not rm -r) removes the reparse point only; a recursive delete would walk into the target.
  const unlink = (link: string) => { try { execFileSync("cmd", ["/c", "rmdir", link], { stdio: "pipe" }); } catch { /* not present */ } };
  const shortPathOf = (target: string): string => {
    try {
      const output = execFileSync("powershell.exe", [
        "-NoProfile", "-Command",
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${target}').ShortPath`
      ]).toString().trim();
      return output;
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

    // 1. A junction inside the allowed root that points outside it.
    mklink(outlink, outsideTarget);
    const readOut = await outcome(() =>
      session.client.callTool({ name: "fs_read", arguments: { path: path.join(outlink, "outside.txt") } })
    );
    check(
      "junction: read through a link that leaves the allowed root is refused",
      readOut.failed && readOut.message.includes("outside allowed roots"),
      readOut.message.slice(0, 200)
    );

    const writeOut = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(outlink, "planted.txt"), content: "x" } })
    );
    check("junction: write through a link that leaves the allowed root is refused", writeOut.failed, writeOut.message.slice(0, 200));
    check("junction: nothing was planted outside the root", !(await pathExists(path.join(outsideTarget, "planted.txt"))));

    // 2. A junction inside the allowed root that lands on a protected path.
    mklink(gitlink, gitDir);
    const writeGit = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: path.join(gitlink, "hooks", "pre-commit"), content: "x" } })
    );
    check("junction: write through a link landing on .git is refused", writeGit.failed, writeGit.message.slice(0, 200));

    // 3. Trailing dot on the .git segment (Windows strips it, so it names the same directory).
    const dotted = path.join(ROOT, "P05_Remote_Agent", ".git.", "hooks", "pre-commit");
    const dottedResult = await outcome(() =>
      session.client.callTool({ name: "fs_write", arguments: { path: dotted, content: "x" } })
    );
    check("trailing-dot .git spelling is refused", dottedResult.failed, dottedResult.message.slice(0, 200));
    check("trailing-dot write created no hook file", !(await pathExists(path.join(gitDir, "hooks", "pre-commit"))));

    // 4. Alternate data stream.
    const adsResult = await outcome(() =>
      session.client.callTool({
        name: "fs_write",
        arguments: { path: path.join(ROOT, "_p05_profile_probe", "probe.txt:evil"), content: "x" }
      })
    );
    check("alternate data stream is refused", adsResult.failed, adsResult.message.slice(0, 200));

    // 5. Extended-length prefix.
    const extendedResult = await outcome(() =>
      session.client.callTool({
        name: "fs_read",
        arguments: { path: "\\\\?\\" + path.join(ROOT, "P05_Remote_Agent", "README.md") }
      })
    );
    check("extended-length path prefix is refused", extendedResult.failed, extendedResult.message.slice(0, 200));

    // 6. Short (8.3) name for .git, when the volume generates them.
    const shortGit = shortPathOf(gitDir);
    const shortBase = shortGit ? path.basename(shortGit) : "";
    if (shortBase && shortBase !== ".git") {
      const shortResult = await outcome(() =>
        session.client.callTool({
          name: "fs_write",
          arguments: { path: path.join(path.dirname(shortGit), shortBase, "hooks", "pre-commit"), content: "x" }
        })
      );
      check(`short-name ${shortBase} spelling is refused`, shortResult.failed, shortResult.message.slice(0, 200));
      console.log(`ok  short-name probe used "${shortBase}" for .git`);
    } else {
      console.log("note  8.3 short names are unavailable on this volume; short-name probe skipped");
    }
  } finally {
    unlink(outlink);
    unlink(gitlink);
    check("junction cleanup left the link target intact", await pathExists(path.join(outsideTarget, "outside.txt")));
    await fs.rm(outsideTarget, { recursive: true, force: true }).catch(() => undefined);
    await session.client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- fail-closed on a bad profile
{
  const failure = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [serverEntry], { env: childEnv({ P05_TOOL_PROFILE: "godmode" }) });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  check("unknown profile exits non-zero", failure.code !== 0, `exit code ${failure.code}`);
  check(
    "unknown profile explains itself on stderr",
    failure.stderr.includes("Unknown P05_TOOL_PROFILE"),
    failure.stderr.split(/\r?\n/)[0]
  );
}

console.log(`PROFILE_EXPOSURE_OK (${checks} checks)`);
