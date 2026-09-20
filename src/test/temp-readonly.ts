/**
 * Temporary read-only layer checks — TMP-R01 … TMP-R06.
 *
 * Spawns the real server over stdio twice: once with the layer off (the default) and once with
 * P05_TEMP_READONLY_ROOT set. It then asserts what a remote client actually sees and receives -
 * the two temporary tools and nothing else, root confinement (including `..` and a junction that
 * leaves the root), the credential filter, the 1 MB cap - and that nothing on disk changes.
 *
 * Run: npm run test:temp-readonly
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "index.js");

// Derived from this file's location: `here` is <repo>/dist/test, so the fixtures land beside the
// repository on whatever drive it is checked out to - the same rule the exposure test follows.
const REPO = path.resolve(here, "..", "..");
const ROOT = path.dirname(REPO);
const PROBE = path.join(ROOT, "_p05_temp_probe");
const OUTSIDE = path.join(path.parse(ROOT).root, "_p05_temp_outside");
const JUNCTION = path.join(ROOT, "_p05_temp_junction");
const OUTSIDE_INI = path.join(path.parse(ROOT).root, "Windows", "win.ini");
const SECRET_TEXT = "TOP-SECRET-VALUE-DO-NOT-LEAK";
const BIG_BYTES = 1024 * 1024 + 64 * 1024; // just over the temporary 1 MB cap
const TEMP_TOOLS = ["list_directory", "read_file"];
const DISCOVERY_TOOLS = ["device_info", "ping"];

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
  env.P05_STATE_DIR = path.join(REPO, ".p05");
  return { ...env, ...extra };
}

type Session = {
  client: Client;
  stderrText: () => string;
};

async function openSession(env: Record<string, string>): Promise<Session> {
  const client = new Client({ name: "p05-temp-readonly-test", version: VERSION });
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

/** A refusal arrives as an isError result or as a JSON-RPC error; both count as failure. */
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

const unlinkJunction = (): void => {
  try {
    execFileSync("cmd", ["/c", "rmdir", JUNCTION], { stdio: "pipe" });
  } catch {
    /* not present */
  }
};

async function writeFixtures(): Promise<void> {
  await fs.rm(PROBE, { recursive: true, force: true });
  await fs.mkdir(path.join(PROBE, "subdir"), { recursive: true });
  await fs.writeFile(path.join(PROBE, "normal.txt"), "temporary layer probe\n", "utf8");
  await fs.writeFile(path.join(PROBE, "notes.md"), "# notes\n", "utf8");
  await fs.writeFile(path.join(PROBE, "subdir", "inner.txt"), "inner\n", "utf8");
  // Credential-shaped fixtures. Created directly (not through the server) so the test can prove
  // the read path refuses them no matter how they got there.
  await fs.writeFile(path.join(PROBE, ".env"), `CONTROL_PLANE_API_KEY=${SECRET_TEXT}\n`, "utf8");
  await fs.writeFile(path.join(PROBE, "creds.key"), SECRET_TEXT, "utf8");
  await fs.writeFile(path.join(PROBE, "secret-token.json"), `{"token":"${SECRET_TEXT}"}`, "utf8");
  await fs.writeFile(path.join(PROBE, "cert.pem"), SECRET_TEXT, "utf8");
  await fs.writeFile(path.join(PROBE, "big.txt"), "x".repeat(BIG_BYTES), "utf8");
}

async function probeSnapshot(): Promise<string> {
  const entries = await fs.readdir(PROBE, { withFileTypes: true });
  const names = entries.map((entry) => `${entry.isDirectory() ? "D" : "F"}:${entry.name}`).sort();
  const normal = await fs.readFile(path.join(PROBE, "normal.txt"));
  const stat = await fs.stat(path.join(PROBE, "normal.txt"));
  return [
    names.join("|"),
    createHash("sha256").update(normal).digest("hex"),
    String(stat.mtimeMs),
    String(stat.size)
  ].join("||");
}

await fs.rm(OUTSIDE, { recursive: true, force: true });
await fs.mkdir(OUTSIDE, { recursive: true });
await fs.writeFile(path.join(OUTSIDE, "outside.txt"), "outside-root\n", "utf8");

try {
  await writeFixtures();

  // ---------------------------------------------------------------- TMP-R01 with the layer off
  {
    const session = await openSession(childEnv({}));
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      sameSet("TMP-R01 gate off: tools/list is the documented discovery surface", names, DISCOVERY_TOOLS);
      for (const name of TEMP_TOOLS) {
        check(`TMP-R01 gate off: ${name} is not advertised`, !names.includes(name));
        const call = await outcome(() => session.client.callTool({ name, arguments: { path: PROBE } }));
        check(`TMP-R01 gate off: calling ${name} is rejected`, call.failed, call.message.slice(0, 160));
      }
      const reportLine = session.stderrText().split(/\r?\n/).find((line) => line.includes("p05.tool_profile"));
      const report = JSON.parse(reportLine!) as { suppressed: { tool: string; reason: string }[] };
      const suppressed = report.suppressed.filter((entry) => TEMP_TOOLS.includes(entry.tool));
      check("TMP-R01 gate off: both temporary tools are reported as suppressed with the gate reason",
        suppressed.length === 2 && suppressed.every((entry) => entry.reason.includes("temporary read-only layer is off")),
        JSON.stringify(suppressed));
    } finally {
      await session.client.close().catch(() => undefined);
    }
    console.log("ok  TMP-R01 gate off -> discovery surface unchanged (device_info + ping)");
  }

  // ------------------------------------------- TMP-R01/R02/R03/R04/R05/R06 with the layer on
  {
    const session = await openSession(childEnv({ P05_TEMP_READONLY_ROOT: ROOT }));
    const before = await probeSnapshot();
    try {
      const tools = (await session.client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      // TMP-R01: exactly two additions, nothing else.
      sameSet("TMP-R01 gate on: tools/list adds exactly the two temporary tools",
        names, [...DISCOVERY_TOOLS, ...TEMP_TOOLS]);
      for (const forbidden of ["fs_write", "fs_delete", "shell_run", "mcp_call_tool", "fs_list", "fs_read"]) {
        check(`TMP-R06 no write/execute tool: ${forbidden} is absent`, !names.includes(forbidden));
      }

      const reportLine = session.stderrText().split(/\r?\n/).find((line) => line.includes("p05.tool_profile"));
      const report = JSON.parse(reportLine!) as { exposed: string[]; suppressed: { tool: string }[] };
      sameSet("TMP-R01 gate on: the startup report exposes both temporary tools",
        report.exposed.filter((name) => TEMP_TOOLS.includes(name)), TEMP_TOOLS);
      check("TMP-R01 gate on: no temporary tool is also reported as suppressed",
        !report.suppressed.some((entry) => TEMP_TOOLS.includes(entry.tool)));

      // TMP-R01 list_directory: names only, credential-shaped entries withheld with a count.
      const listing = textOf(await session.client.callTool({ name: "list_directory", arguments: { path: PROBE } }));
      check("TMP-R01 list: a normal file is listed", listing.includes("[FILE] normal.txt"), listing.slice(0, 200));
      check("TMP-R01 list: a subdirectory is listed", listing.includes("[DIR] subdir"), listing.slice(0, 200));
      for (const hidden of [".env", "creds.key", "secret-token.json", "cert.pem"]) {
        check(`TMP-R04 list: ${hidden} is not disclosed`, !listing.includes(hidden), listing.slice(0, 300));
      }
      check("TMP-R04 list: withheld entries are counted instead of silently missing",
        /\[SKIP\] \d+ protected or credential-like/.test(listing), listing.slice(0, 300));

      // TMP-R01 read_file happy path.
      const normal = textOf(await session.client.callTool({ name: "read_file", arguments: { path: path.join(PROBE, "normal.txt") } }));
      check("TMP-R01 read: a normal text file is returned", normal.includes("temporary layer probe"), normal.slice(0, 160));

      // TMP-R04 credential filter, each refusal also asserted to not leak the secret.
      for (const rel of [".env", "creds.key", "secret-token.json", "cert.pem"]) {
        const refused = await outcome(() =>
          session.client.callTool({ name: "read_file", arguments: { path: path.join(PROBE, rel) } }));
        check(`TMP-R04 read: ${rel} is refused`, refused.failed, refused.message.slice(0, 200));
        check(`TMP-R04 read: ${rel} refusal does not echo the secret`, !refused.message.includes(SECRET_TEXT));
      }
      const repoEnv = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: path.join(REPO, ".env") } }));
      check("TMP-R04 read: the repository .env is refused", repoEnv.failed, repoEnv.message.slice(0, 200));

      // TMP-R05 size cap.
      const tooBig = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: path.join(PROBE, "big.txt") } }));
      check("TMP-R05 read: a file over 1 MB is refused", tooBig.failed && tooBig.message.includes("temporary read limit"),
        tooBig.message.slice(0, 200));

      // TMP-R02 / TMP-R03 confinement.
      const outsideRoot = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: OUTSIDE_INI } }));
      check("TMP-R02 read: a path outside the allowed roots is refused", outsideRoot.failed, outsideRoot.message.slice(0, 200));

      const traversal = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: path.join(PROBE, "..", "..", "Windows", "win.ini") } }));
      check("TMP-R03 read: `..` traversal out of the roots is refused", traversal.failed, traversal.message.slice(0, 200));
      const traversalList = await outcome(() =>
        session.client.callTool({ name: "list_directory", arguments: { path: path.join(PROBE, "..", "..", "Windows") } }));
      check("TMP-R03 list: `..` traversal out of the roots is refused", traversalList.failed, traversalList.message.slice(0, 200));

      unlinkJunction();
      execFileSync("cmd", ["/c", "mklink", "/J", JUNCTION, OUTSIDE], { stdio: "pipe" });
      const viaJunction = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: path.join(JUNCTION, "outside.txt") } }));
      check("TMP-R03 read: a junction leaving the roots is refused",
        viaJunction.failed && /link|allowed roots|temporary read-only root/.test(viaJunction.message),
        viaJunction.message.slice(0, 240));
      check("TMP-R03 read: the junction refusal does not name the link target",
        !viaJunction.message.includes(path.basename(OUTSIDE)), viaJunction.message.slice(0, 240));
      check("TMP-R03 read: nothing was written through the junction",
        (await fs.readFile(path.join(OUTSIDE, "outside.txt"), "utf8")).trim() === "outside-root");

      // An extended-length prefix is refused by the existing guard, not by this layer's own check.
      const extended = await outcome(() =>
        session.client.callTool({ name: "read_file", arguments: { path: "\\\\?\\" + path.join(PROBE, "normal.txt") } }));
      check("TMP-R03 read: an extended-length prefix is refused", extended.failed, extended.message.slice(0, 200));

      // TMP-R06: read-only means the filesystem did not move.
      const after = await probeSnapshot();
      check("TMP-R06 no side effects: fixture names, content hash, size and mtime are unchanged", after === before,
        `${before} != ${after}`);
    } finally {
      unlinkJunction();
      await session.client.close().catch(() => undefined);
    }
    console.log("ok  TMP-R01..R06 gate on -> two read tools, confinement, credential filter, size cap, no side effects");
  }

  // ---------------------------------------------------------------- TMP-R02: the layer narrows
  {
    // Temporary root = the repository only, while REMOTE_AGENT_ALLOWED_ROOTS is its parent.
    // The outer guard accepts the parent's other entries; the temporary root must still refuse.
    const session = await openSession(childEnv({ P05_TEMP_READONLY_ROOT: REPO }));
    try {
      const inside = textOf(await session.client.callTool({ name: "read_file", arguments: { path: path.join(REPO, "README.md") } }));
      check("TMP-R02 narrow: a file inside the temporary root is readable", inside.length > 0);

      const siblingDir = path.join(ROOT, "_p05_deploy");
      if (await pathExists(siblingDir)) {
        const sibling = await outcome(() =>
          session.client.callTool({ name: "list_directory", arguments: { path: siblingDir } }));
        check("TMP-R02 narrow: a sibling directory inside the allowed roots but outside the temporary root is refused",
          sibling.failed && sibling.message.includes("temporary read-only root"), sibling.message.slice(0, 240));
      } else {
        console.log("note  sibling probe directory is absent; narrowing check used the allowed-root escape instead");
        const sibling = await outcome(() =>
          session.client.callTool({ name: "list_directory", arguments: { path: ROOT } }));
        check("TMP-R02 narrow: the allowed root above the temporary root is refused",
          sibling.failed && sibling.message.includes("temporary read-only root"), sibling.message.slice(0, 240));
      }
    } finally {
      await session.client.close().catch(() => undefined);
    }
    console.log("ok  TMP-R02 narrowing -> the temporary root cannot be escaped even inside the allowed roots");
  }

  // ---------------------------------------------------------------- fail closed on bad config
  async function spawnExpectingFailure(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [serverEntry], { env });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
      child.on("close", (code) => resolve({ code, stderr }));
    });
  }

  {
    const relative = await spawnExpectingFailure(childEnv({ P05_TEMP_READONLY_ROOT: "_p05_temp_probe" }));
    check("config: a relative temporary root exits non-zero", relative.code !== 0, `exit code ${relative.code}`);
    check("config: a relative temporary root explains itself",
      relative.stderr.includes("must be an absolute path"), relative.stderr.split(/\r?\n/)[0]);
  }

  {
    const outside = await spawnExpectingFailure(childEnv({
      P05_TEMP_READONLY_ROOT: path.join(path.parse(ROOT).root, "Windows")
    }));
    check("config: a temporary root outside the allowed roots exits non-zero", outside.code !== 0, `exit code ${outside.code}`);
    check("config: an out-of-root temporary root explains itself",
      outside.stderr.includes("outside the allowed roots"), outside.stderr.split(/\r?\n/)[0]);
  }

  {
    // A blank value means "off", not "refuse to start": the documented install path leaves the
    // line blank so copying the example configuration keeps working.
    const session = await openSession(childEnv({ P05_TEMP_READONLY_ROOT: "   " }));
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      sameSet("config: a blank temporary root leaves the layer off", names, DISCOVERY_TOOLS);
    } finally {
      await session.client.close().catch(() => undefined);
    }
    console.log("ok  fail closed on a relative or out-of-root temporary root; blank means off");
  }

  console.log(`TEMP_READONLY_OK (${checks} checks)`);
} finally {
  unlinkJunction();
  await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(PROBE, { recursive: true, force: true }).catch(() => undefined);
}
