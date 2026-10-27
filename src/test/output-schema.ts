import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CAPABILITIES } from "../capability/registry.js";
import { serializedBytes } from "../tools/result-budget.js";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const serverEntry = path.resolve(here, "..", "index.js");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_")) env[key] = value;
  }
  env.REMOTE_AGENT_ALLOWED_ROOTS = REPO;
  env.REMOTE_AGENT_DEFAULT_CWD = REPO;
  env.P05_TOOL_PROFILE = "full";
  env.MATLAB_MCP_ENABLED = "false";
  return env;
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : undefined;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

const V2_FIXTURE = path.join(REPO, "_p05_output_schema_v2_fixture.txt");
const V2_LINES = Array.from(
  { length: 1200 },
  (_, index) => `line-${String(index + 1).padStart(4, "0")} ${"y".repeat(30)}\n`
);
const V2_TEXT = V2_LINES.join("");
await fs.writeFile(V2_FIXTURE, V2_TEXT, "utf8");
const V2_SHA = createHash("sha256").update(Buffer.from(V2_TEXT, "utf8")).digest("hex");

const PATCH_FIXTURE = path.join(REPO, "_p05_output_schema_patch_fixture.txt");
const PATCH_TEXT = "alpha\nbeta\n";
const PATCH_EXPECTED_TEXT = "alpha\nBETA\n";
await fs.writeFile(PATCH_FIXTURE, PATCH_TEXT, "utf8");
const PATCH_SHA = createHash("sha256").update(Buffer.from(PATCH_TEXT, "utf8")).digest("hex");
const PATCH_EXPECTED_SHA = createHash("sha256")
  .update(Buffer.from(PATCH_EXPECTED_TEXT, "utf8"))
  .digest("hex");

const client = new Client({ name: "p05-output-schema-test", version: VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: inheritedEnv(),
  stderr: "pipe"
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = CAPABILITIES.filter((capability) => capability.name !== "fs_read").map((capability) => capability.name).sort();

  check(
    "output-schema: full surface covers every Core capability",
    names.join(",") === expected.join(","),
    `expected ${expected.length}, got ${names.length}`
  );

  for (const tool of listed.tools) {
    const capability = CAPABILITIES.find((entry) => entry.name === tool.name);
    if (!capability) {
      throw new Error(`FAIL annotations: undeclared Core tool ${tool.name}`);
    }

    const annotations = tool.annotations;
    const readOnly = capability.risk === "read";
    const openWorld =
      capability.scope === "downstream" || capability.scope === "external";

    check(
      `annotations: ${tool.name} readOnlyHint follows capability risk`,
      annotations?.readOnlyHint === readOnly,
      JSON.stringify({ capability, annotations })
    );
    check(
      `annotations: ${tool.name} destructiveHint follows capability risk`,
      annotations?.destructiveHint === !readOnly,
      JSON.stringify({ capability, annotations })
    );
    check(
      `annotations: ${tool.name} idempotentHint follows capability risk`,
      annotations?.idempotentHint === readOnly,
      JSON.stringify({ capability, annotations })
    );
    check(
      `annotations: ${tool.name} openWorldHint follows capability scope`,
      annotations?.openWorldHint === openWorld,
      JSON.stringify({ capability, annotations })
    );
  }

  for (const tool of listed.tools) {
    const schema = tool.outputSchema as { type?: unknown; properties?: unknown } | undefined;
    check(`output-schema: ${tool.name} advertises outputSchema`, Boolean(schema), JSON.stringify(tool));
    check(
      `output-schema: ${tool.name} outputSchema has object root`,
      schema?.type === "object",
      JSON.stringify(schema)
    );
  }

  const readManyTool = listed.tools.find((tool) => tool.name === "fs_read_many");
  const readManyInput = readManyTool?.inputSchema as {
    type?: unknown;
    properties?: Record<string, unknown>;
  } | undefined;
  check(
    "input-schema: fs_read_many has an object root",
    readManyInput?.type === "object",
    JSON.stringify(readManyInput).slice(0, 400)
  );
  check(
    "input-schema: fs_read_many advertises legacy paths and V2 requests",
    Boolean(readManyInput?.properties?.paths) && Boolean(readManyInput?.properties?.requests),
    JSON.stringify(readManyInput?.properties ?? {})
  );

  const patchManyTool = listed.tools.find((tool) => tool.name === "apply_patch_many");
  const patchManyInput = patchManyTool?.inputSchema as {
    type?: unknown;
    properties?: Record<string, unknown>;
  } | undefined;
  check(
    "input-schema: apply_patch_many has an object root",
    patchManyInput?.type === "object",
    JSON.stringify(patchManyInput).slice(0, 400)
  );
  check(
    "input-schema: apply_patch_many advertises V2 patches and dry_run",
    Boolean(patchManyInput?.properties?.patches) &&
      Boolean(patchManyInput?.properties?.contract_version) &&
      Boolean(patchManyInput?.properties?.dry_run),
    JSON.stringify(patchManyInput?.properties ?? {})
  );

  // Runtime-confirmed tools are covered by permission tests. These samples validate
  // structuredContent only for calls that are expected to execute without confirmation.
  const samples: Array<[string, Record<string, unknown>]> = [
    ["device_info", {}],
    ["ping", {}],
    ["workspace_list", {}],
    ["workspace_current", {}],
    ["activity_recent", { limit: 5 }],
    ["plugin_list", {}],
    ["recovery_status", { limit: 5 }],
    ["fs_list", { path: "." }],
    ["fs_read_many", { paths: ["README.md"] }],
    ["fs_read_many", { paths: ["README.md", "src/index.ts"] }],
    ["fs_search", { query: "export function", path: "src/tools", max_results: 5 }],
    ["git_status", {}],
    ["git_workspace_audit", {}],
    ["git_diff_stat", {}],
    ["shell_run", { command: "Write-Output p05-structured-output" }],
    ["mcp_status", {}]
  ];

  for (const [name, args] of samples) {
    const result = await client.callTool({ name, arguments: args });
    const structured = structuredOf(result);
    check(`structured-content: ${name} returns an object`, Boolean(structured), JSON.stringify(result).slice(0, 400));
  }

  const fixtureName = path.basename(V2_FIXTURE);
  const limited = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [{ path: fixtureName, offset: 0, limit: 50 }],
      max_bytes: 4096
    }
  });
  const limitedStructured = structuredOf(limited);
  check("v2: contract_version is explicit", limitedStructured?.contract_version === 2, JSON.stringify(limitedStructured).slice(0, 300));
  const limitedFiles = Array.isArray(limitedStructured?.files)
    ? limitedStructured.files as Array<Record<string, unknown>>
    : [];
  const limitedFirst = limitedFiles[0] ?? {};
  check("v2: file item succeeds", limitedFirst.ok === true, JSON.stringify(limitedFirst));
  check("v2: raw-byte sha256 returned", limitedFirst.sha256 === V2_SHA, String(limitedFirst.sha256));
  check("v2: totalLines returned", limitedFirst.totalLines === V2_LINES.length, String(limitedFirst.totalLines));
  check(
    "v2: truncated file range has nextOffset",
    limitedFirst.complete === false && typeof limitedFirst.nextOffset === "number" && limitedFirst.nextOffset > 0,
    JSON.stringify(limitedFirst)
  );
  check(
    "v2: batch pendingIndexes is empty when one request was handled",
    Array.isArray(limitedStructured?.pendingIndexes) && limitedStructured.pendingIndexes.length === 0,
    JSON.stringify(limitedStructured?.pendingIndexes)
  );
  check(
    "v2: actual MCP client result respects max_bytes",
    serializedBytes(limited) <= 4096,
    `${serializedBytes(limited)} bytes`
  );
  check(
    "v2: plain-text content exposes the file body",
    textOf(limited).includes(V2_LINES[0]!.trimEnd()),
    textOf(limited).slice(0, 300)
  );
  check("v2: plain-text content exposes the version", textOf(limited).includes(V2_SHA));
  check(
    "v2: plain-text content exposes continuation",
    textOf(limited).includes(`nextOffset=${limitedFirst.nextOffset}`)
  );

  const continuationOffset = limitedFirst.nextOffset as number;
  const continued = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [{
        path: fixtureName,
        offset: continuationOffset,
        limit: 50,
        expected_sha256: V2_SHA
      }],
      max_bytes: 4096
    }
  });
  const continuedStructured = structuredOf(continued);
  const continuedFirst = Array.isArray(continuedStructured?.files)
    ? (continuedStructured.files as Array<Record<string, unknown>>)[0] ?? {}
    : {};
  check("v2: continuation item succeeds", continuedFirst.ok === true, JSON.stringify(continuedFirst));
  check(
    "v2: continuation starts at the exact next line",
    typeof continuedFirst.text === "string" && continuedFirst.text.startsWith(V2_LINES[continuationOffset]!),
    String(continuedFirst.text).slice(0, 120)
  );
  check("v2: continuation version is stable", continuedFirst.sha256 === V2_SHA);

  const defaultBudget = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [{ path: fixtureName, offset: 0, limit: 1200 }]
    }
  });
  const defaultStructured = structuredOf(defaultBudget);
  const defaultFirst = Array.isArray(defaultStructured?.files)
    ? (defaultStructured.files as Array<Record<string, unknown>>)[0] ?? {}
    : {};
  check(
    "v2: default max_bytes limits the actual MCP client result",
    serializedBytes(defaultBudget) <= 65536,
    `${serializedBytes(defaultBudget)} bytes`
  );
  check(
    "v2: default budget trims and provides a forward cursor",
    defaultFirst.complete === false && typeof defaultFirst.nextOffset === "number" && defaultFirst.nextOffset > 0,
    JSON.stringify(defaultFirst)
  );

  const maximumBudget = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [{ path: fixtureName, offset: 0, limit: 1200 }],
      max_bytes: 262144
    }
  });
  const maximumStructured = structuredOf(maximumBudget);
  const maximumFirst = Array.isArray(maximumStructured?.files)
    ? (maximumStructured.files as Array<Record<string, unknown>>)[0] ?? {}
    : {};
  check(
    "v2: maximum max_bytes limits the actual MCP client result",
    serializedBytes(maximumBudget) <= 262144,
    `${serializedBytes(maximumBudget)} bytes`
  );
  check(
    "v2: maximum budget returns the full requested range",
    maximumFirst.returnedLines === 1200 && maximumFirst.complete === true,
    JSON.stringify(maximumFirst)
  );

  let mixedRejected = false;
  try {
    const mixed = await client.callTool({
      name: "fs_read_many",
      arguments: {
        contract_version: 2,
        paths: [fixtureName],
        requests: [{ path: fixtureName, offset: 0, limit: 1 }]
      }
    });
    mixedRejected = Boolean((mixed as { isError?: boolean }).isError);
  } catch {
    mixedRejected = true;
  }
  check("v2: paths and requests are rejected at the protocol boundary", mixedRejected);

  const patchFixtureName = path.basename(PATCH_FIXTURE);
  const patchEdits = [{ old_text: "beta", new_text: "BETA" }];
  const patchDryRun = await client.callTool({
    name: "apply_patch_many",
    arguments: {
      contract_version: 2,
      dry_run: true,
      patches: [{
        path: patchFixtureName,
        expected_sha256: PATCH_SHA,
        edits: patchEdits
      }]
    }
  });
  const patchDryRunStructured = structuredOf(patchDryRun);
  const patchDryRunFiles = Array.isArray(patchDryRunStructured?.files)
    ? patchDryRunStructured.files as Array<Record<string, unknown>>
    : [];
  check(
    "patch v2: dry_run status and no effect",
    patchDryRunStructured?.status === "dry_run" &&
      (patchDryRunStructured?.outcome as { effectState?: unknown } | undefined)?.effectState === "none",
    JSON.stringify(patchDryRunStructured).slice(0, 400)
  );
  check(
    "patch v2: dry_run returns expected hash",
    patchDryRunFiles[0]?.sha256 === PATCH_EXPECTED_SHA &&
      patchDryRunFiles[0]?.original_sha256 === PATCH_SHA &&
      patchDryRunFiles[0]?.applied === false,
    JSON.stringify(patchDryRunFiles[0] ?? {})
  );
  check(
    "patch v2: dry_run text includes diff and expected hash",
    textOf(patchDryRun).includes("- beta") &&
      textOf(patchDryRun).includes("+ BETA") &&
      textOf(patchDryRun).includes("expected_sha256=" + PATCH_EXPECTED_SHA),
    textOf(patchDryRun).slice(0, 300)
  );
  check(
    "patch v2: dry_run did not write",
    await fs.readFile(PATCH_FIXTURE, "utf8") === PATCH_TEXT
  );

  const patchCommit = await client.callTool({
    name: "apply_patch_many",
    arguments: {
      contract_version: 2,
      dry_run: false,
      patches: [{
        path: patchFixtureName,
        expected_sha256: PATCH_SHA,
        edits: patchEdits
      }]
    }
  });
  const patchCommitStructured = structuredOf(patchCommit);
  const patchCommitFiles = Array.isArray(patchCommitStructured?.files)
    ? patchCommitStructured.files as Array<Record<string, unknown>>
    : [];
  check(
    "patch v2: commit reports applied and the new hash",
    patchCommitStructured?.status === "committed" &&
      (patchCommitStructured?.outcome as { effectState?: unknown } | undefined)?.effectState === "applied" &&
      patchCommitFiles[0]?.sha256 === PATCH_EXPECTED_SHA &&
      patchCommitFiles[0]?.applied === true,
    JSON.stringify(patchCommitStructured).slice(0, 400)
  );
  check(
    "patch v2: commit writes the expected content",
    await fs.readFile(PATCH_FIXTURE, "utf8") === PATCH_EXPECTED_TEXT
  );

  const legacy = await client.callTool({
    name: "fs_read_many",
    arguments: { paths: ["README.md"] }
  });
  const legacyStructured = structuredOf(legacy);
  check(
    "legacy: success fields and per-file text are unchanged",
    legacyStructured?.successCount === 1 &&
      legacyStructured?.contract_version === undefined &&
      Array.isArray(legacyStructured?.files) &&
      (legacyStructured.files as Array<Record<string, unknown>>)[0]?.ok === true &&
      typeof (legacyStructured.files as Array<Record<string, unknown>>)[0]?.text === "string",
    JSON.stringify(legacyStructured).slice(0, 300)
  );
  check(
    "legacy: text content remains a compact summary, not a body copy",
    !textOf(legacy).includes("P05 Remote Agent"),
    textOf(legacy).slice(0, 200)
  );

  console.log(`OUTPUT_SCHEMA_OK (${checks} checks)`);
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(V2_FIXTURE, { force: true });
  await fs.rm(PATCH_FIXTURE, { force: true });
}
