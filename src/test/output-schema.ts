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

const AMBIGUOUS_FIXTURE = path.join(REPO, "_p05_output_schema_ambiguous_fixture.txt");
const AMBIGUOUS_TEXT = "x x\n";
await fs.writeFile(AMBIGUOUS_FIXTURE, AMBIGUOUS_TEXT, "utf8");
const AMBIGUOUS_SHA = createHash("sha256")
  .update(Buffer.from(AMBIGUOUS_TEXT, "utf8"))
  .digest("hex");

const M1_E2_FIXTURE = path.join(REPO, "_p05_output_schema_e2_fixture.txt");
await fs.writeFile(M1_E2_FIXTURE, "x".repeat(12000), "utf8");

const SEARCH_BUDGET_DIR = path.join(REPO, "_p05_output_schema_search_budget");
await fs.rm(SEARCH_BUDGET_DIR, { recursive: true, force: true });
await fs.mkdir(SEARCH_BUDGET_DIR, { recursive: true });
const searchBudgetLine = "needle" + "中".repeat(234);
for (let index = 0; index < 100; index += 1) {
  await fs.writeFile(
    path.join(SEARCH_BUDGET_DIR, String(index) + ".txt"),
    (searchBudgetLine + "\n").repeat(5),
    "utf8"
  );
}

const PATCH_BUDGET_DIR = path.join(REPO, "_p05_output_schema_patch_budget");
await fs.rm(PATCH_BUDGET_DIR, { recursive: true, force: true });
await fs.mkdir(PATCH_BUDGET_DIR, { recursive: true });
const patchBudgetEdits = Array.from({ length: 4 }, (_, index) => ({
  old_text: String(index) + "\u0001".repeat(166),
  new_text: String(index) + "\u0002".repeat(166)
}));
const patchBudgetOriginal = patchBudgetEdits.map((edit) => edit.old_text).join("\n");
const patchBudgetHash = createHash("sha256")
  .update(Buffer.from(patchBudgetOriginal, "utf8"))
  .digest("hex");
const patchBudgetPaths: string[] = [];
for (let index = 0; index < 20; index += 1) {
  const name = "f" + String(index).padStart(2, "0") + ".txt";
  await fs.writeFile(path.join(PATCH_BUDGET_DIR, name), patchBudgetOriginal, "utf8");
  patchBudgetPaths.push(path.join(path.basename(PATCH_BUDGET_DIR), name));
}

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
  check(
    "v2: normal truncation is not an MCP error",
    (limited as { isError?: boolean }).isError !== true,
    JSON.stringify({ isError: (limited as { isError?: boolean }).isError })
  );

  const staleRead = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [{
        path: fixtureName,
        offset: 0,
        limit: 1,
        expected_sha256: "0".repeat(64)
      }],
      max_bytes: 4096
    }
  });
  const staleReadStructured = structuredOf(staleRead);
  const staleReadFiles = Array.isArray(staleReadStructured?.files)
    ? staleReadStructured.files as Array<Record<string, unknown>>
    : [];
  check(
    "v2 error: stale read is an MCP error",
    (staleRead as { isError?: boolean }).isError === true,
    JSON.stringify({ isError: (staleRead as { isError?: boolean }).isError })
  );
  check(
    "v2 error: stale read keeps structured diagnostics",
    staleReadStructured?.contract_version === 2 &&
      (staleReadStructured?.outcome as { status?: unknown } | undefined)?.status === "conflict" &&
      staleReadFiles[0]?.errorCode === "STALE_REVISION" &&
      textOf(staleRead).includes("STALE_REVISION"),
    JSON.stringify(staleReadStructured).slice(0, 500)
  );
  check(
    "v2 error: stale read including isError respects max_bytes",
    serializedBytes(staleRead) <= 4096,
    `${serializedBytes(staleRead)} bytes`
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

  const searchV2 = await client.callTool({
    name: "fs_search",
    arguments: {
      contract_version: 2,
      query: "export function",
      path: "src/tools",
      max_results: 1
    }
  });
  const searchV2Structured = structuredOf(searchV2);
  const searchV2Coverage = searchV2Structured?.coverage as {
    complete?: unknown;
    stopReason?: unknown;
    scannedFiles?: unknown;
    skippedByReason?: unknown;
  } | undefined;
  check(
    "search v2: coverage and outcome are returned",
    searchV2Structured?.contract_version === 2 &&
      searchV2Coverage?.complete === false &&
      searchV2Coverage?.stopReason === "result_limit" &&
      typeof searchV2Coverage?.scannedFiles === "number" &&
      Boolean(searchV2Coverage?.skippedByReason) &&
      (searchV2Structured?.outcome as { code?: unknown } | undefined)?.code === "SEARCH_TRUNCATED",
    JSON.stringify(searchV2Structured).slice(0, 500)
  );
  check(
    "search v2: normal limit truncation is not an MCP error",
    (searchV2 as { isError?: boolean }).isError !== true,
    JSON.stringify({ isError: (searchV2 as { isError?: boolean }).isError })
  );
  check(
    "search v2: text client sees coverage and outcome",
    textOf(searchV2).includes("Coverage: complete=false") &&
      textOf(searchV2).includes("stopReason=result_limit") &&
      textOf(searchV2).includes("SEARCH_TRUNCATED"),
    textOf(searchV2).slice(0, 400)
  );

  const searchBudgetName = path.basename(SEARCH_BUDGET_DIR);
  for (const maxBytes of [4096, 65536, 262144]) {
    const budgeted = await client.callTool({
      name: "fs_search",
      arguments: {
        contract_version: 2,
        query: "needle",
        path: searchBudgetName,
        max_results: 100,
        max_bytes: maxBytes
      }
    });
    const budgetedStructured = structuredOf(budgeted);
    check(
      `search v2 budget ${maxBytes}: selected max_bytes returned`,
      budgetedStructured?.max_bytes === maxBytes,
      JSON.stringify(budgetedStructured).slice(0, 300)
    );
    check(
      `search v2 budget ${maxBytes}: actual client result within budget`,
      serializedBytes(budgeted) <= maxBytes,
      `${serializedBytes(budgeted)} bytes`
    );
    check(
      `search v2 budget ${maxBytes}: response truncation is explicit`,
      budgetedStructured?.responseTruncated === true &&
        typeof budgetedStructured?.returnedFiles === "number" &&
        typeof budgetedStructured?.returnedMatches === "number" &&
        budgetedStructured.returnedMatches > 0,
      JSON.stringify(budgetedStructured).slice(0, 400)
    );
    check(
      `search v2 budget ${maxBytes}: coverage and outcome remain meaningful`,
      (budgetedStructured?.coverage as { complete?: unknown } | undefined)?.complete === false &&
        (budgetedStructured?.outcome as { code?: unknown } | undefined)?.code === "SEARCH_TRUNCATED" &&
        (budgeted as { isError?: boolean }).isError !== true,
      JSON.stringify(budgetedStructured).slice(0, 400)
    );
  }

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
    "patch v2: dry_run is not an MCP error",
    (patchDryRun as { isError?: boolean }).isError !== true
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
    "patch v2: commit is not an MCP error",
    (patchCommit as { isError?: boolean }).isError !== true
  );
  check(
    "patch v2: commit writes the expected content",
    await fs.readFile(PATCH_FIXTURE, "utf8") === PATCH_EXPECTED_TEXT
  );

  const ambiguousName = path.basename(AMBIGUOUS_FIXTURE);
  const ambiguousPatch = await client.callTool({
    name: "apply_patch_many",
    arguments: {
      contract_version: 2,
      patches: [{
        path: ambiguousName,
        expected_sha256: AMBIGUOUS_SHA,
        edits: [{ old_text: "x", new_text: "y" }]
      }]
    }
  });
  const ambiguousStructured = structuredOf(ambiguousPatch);
  const ambiguousFiles = Array.isArray(ambiguousStructured?.files)
    ? ambiguousStructured.files as Array<Record<string, unknown>>
    : [];
  check(
    "patch v2 error: ambiguous edit is an MCP error",
    (ambiguousPatch as { isError?: boolean }).isError === true,
    JSON.stringify({ isError: (ambiguousPatch as { isError?: boolean }).isError })
  );
  check(
    "patch v2 error: ambiguous edit keeps structured diagnostics",
    ambiguousStructured?.status === "rejected" &&
      (ambiguousStructured?.outcome as { code?: unknown } | undefined)?.code === "AMBIGUOUS_EDIT" &&
      ambiguousFiles[0]?.errorCode === "AMBIGUOUS_EDIT" &&
      textOf(ambiguousPatch).includes("AMBIGUOUS_EDIT"),
    JSON.stringify(ambiguousStructured).slice(0, 500)
  );
  check(
    "patch v2 error: ambiguous fixture is untouched",
    await fs.readFile(AMBIGUOUS_FIXTURE, "utf8") === AMBIGUOUS_TEXT
  );

  for (const maxBytes of [4096, 65536, 262144]) {
    const patchBudget = await client.callTool({
      name: "apply_patch_many",
      arguments: {
        contract_version: 2,
        dry_run: true,
        max_bytes: maxBytes,
        patches: patchBudgetPaths.map((targetPath) => ({
          path: targetPath,
          expected_sha256: patchBudgetHash,
          edits: patchBudgetEdits
        }))
      }
    });
    const patchBudgetStructured = structuredOf(patchBudget);
    check(
      `patch v2 budget ${maxBytes}: actual client result within budget`,
      serializedBytes(patchBudget) <= maxBytes,
      `${serializedBytes(patchBudget)} bytes`
    );
    check(
      `patch v2 budget ${maxBytes}: selected max_bytes returned`,
      patchBudgetStructured?.max_bytes === maxBytes,
      JSON.stringify(patchBudgetStructured).slice(0, 300)
    );
    if (maxBytes === 4096) {
      check(
        "patch v2 budget 4096: necessary statuses do not fit and no write occurs",
        patchBudgetStructured?.status === "rejected" &&
          (patchBudgetStructured?.outcome as { code?: unknown; effectState?: unknown } | undefined)?.code === "RESULT_BUDGET_TOO_SMALL" &&
          (patchBudgetStructured?.outcome as { effectState?: unknown } | undefined)?.effectState === "none" &&
          Array.isArray(patchBudgetStructured?.files) &&
          patchBudgetStructured.files.length === 0 &&
          (patchBudget as { isError?: boolean }).isError === true,
        JSON.stringify(patchBudgetStructured).slice(0, 400)
      );
    } else {
      check(
        `patch v2 budget ${maxBytes}: all targets retain status`,
        patchBudgetStructured?.status === "dry_run" &&
          Array.isArray(patchBudgetStructured?.files) &&
          patchBudgetStructured.files.length === 20,
        JSON.stringify(patchBudgetStructured).slice(0, 400)
      );
      if (maxBytes === 65536) {
        const patchBudgetFiles = patchBudgetStructured?.files as Array<Record<string, unknown>>;
        const firstDiff = patchBudgetFiles[0]?.diff as { previewTruncated?: unknown } | undefined;
        check(
          "patch v2 budget 65536: optional preview is explicitly truncated",
          patchBudgetStructured?.responseTruncated === true &&
            firstDiff?.previewTruncated === true,
          JSON.stringify(patchBudgetStructured).slice(0, 400)
        );
      }
    }
  }
  for (const targetPath of patchBudgetPaths) {
    check(
      "patch v2 budget: dry-run leaves the fixture unchanged",
      await fs.readFile(path.join(REPO, targetPath), "utf8") === patchBudgetOriginal
    );
  }

  const e2Name = path.basename(M1_E2_FIXTURE);
  const mixedFailure = await client.callTool({
    name: "fs_read_many",
    arguments: {
      contract_version: 2,
      requests: [
        { path: "missing-e2.txt", offset: 0, limit: 1 },
        { path: e2Name, offset: 0, limit: 1 }
      ],
      max_bytes: 4096
    }
  });
  const mixedFailureStructured = structuredOf(mixedFailure);
  const mixedFailureFiles = Array.isArray(mixedFailureStructured?.files)
    ? mixedFailureStructured.files as Array<Record<string, unknown>>
    : [];
  check(
    "M1 MCP: failure + pending remains an MCP error",
    (mixedFailure as { isError?: boolean }).isError === true &&
      mixedFailureStructured?.failureCount === 1 &&
      (mixedFailureStructured?.outcome as { code?: unknown } | undefined)?.code === "NOT_FOUND" &&
      JSON.stringify(mixedFailureStructured?.pendingIndexes) === "[1]",
    JSON.stringify(mixedFailureStructured).slice(0, 500)
  );
  check(
    "M1 MCP: failure + pending keeps the failed item",
    mixedFailureFiles[0]?.errorCode === "NOT_FOUND",
    JSON.stringify(mixedFailureFiles)
  );

  const auditResult = await client.callTool({
    name: "activity_recent",
    arguments: { limit: 30 }
  });
  const auditEvents = Array.isArray(structuredOf(auditResult)?.events)
    ? structuredOf(auditResult)!.events as Array<Record<string, unknown>>
    : [];
  const mixedAudit = auditEvents.find((event) =>
    event.capability === "fs_read_many" &&
    event.resultCode === "NOT_FOUND"
  );
  check(
    "M1 MCP: mixed failure is audited as failed and truncated",
    mixedAudit?.state === "failed" && mixedAudit?.resultTruncated === true,
    JSON.stringify(mixedAudit ?? {})
  );
  const truncatedAudit = auditEvents.find((event) =>
    event.capability === "fs_read_many" &&
    event.resultCode === "READ_TRUNCATED"
  );
  check(
    "M1 MCP: normal truncation is audited as succeeded and truncated",
    truncatedAudit?.state === "succeeded" && truncatedAudit?.resultTruncated === true,
    JSON.stringify(truncatedAudit ?? {})
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
  await fs.rm(AMBIGUOUS_FIXTURE, { force: true });
  await fs.rm(M1_E2_FIXTURE, { force: true });
  await fs.rm(SEARCH_BUDGET_DIR, { recursive: true, force: true });
  await fs.rm(PATCH_BUDGET_DIR, { recursive: true, force: true });
}
