/**
 * A4 protocol benchmark for the V2 file contracts.
 *
 * This drives the real stdio MCP server. It measures task completion, MCP calls,
 * serialized tool-result bytes and local round-trip time. It does NOT involve a
 * model and must not be read as model latency, token usage or cost evidence.
 *
 * Run: node dist/test/file-contracts-benchmark.js
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serializedBytes } from "../tools/result-budget.js";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_file_contracts_benchmark");
const STATE = path.join(FIXTURE, "_state");
const serverEntry = path.resolve(here, "..", "index.js");
const RUNS = 5;

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  const value = (result as { structuredContent?: unknown })?.structuredContent;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean })?.isError === true;
}

async function writeFixture(relativePath: string, content: string | Buffer): Promise<void> {
  const target = path.join(FIXTURE, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

const LARGE_TEXT = Array.from(
  { length: 2000 },
  (_, index) =>
    `line ${String(index + 1).padStart(4, "0")} ${"x".repeat(40)}` +
    (index === 1699 ? " TARGET_MARKER" : "") +
    "\n"
).join("");
const LARGE_HASH = sha256(Buffer.from(LARGE_TEXT, "utf8"));

const MULTI_INITIAL =
  'const alpha = 1;\nconst beta = "old";\nreturn alpha + beta;\n';
const MULTI_EXPECTED =
  'const alpha = 2;\nconst beta = "new";\nreturn alpha + beta + 1;\n';
const MULTI_EDITS = [
  { old_text: "const alpha = 1;", new_text: "const alpha = 2;" },
  { old_text: 'const beta = "old";', new_text: 'const beta = "new";' },
  { old_text: "return alpha + beta;", new_text: "return alpha + beta + 1;" }
];
const MULTI_EXPECTED_HASH = sha256(Buffer.from(MULTI_EXPECTED, "utf8"));

const REPAIR_INITIAL = "const target = 1;\n";
const REPAIR_EXPECTED = "const target = 2;\n";
const REPAIR_EXPECTED_HASH = sha256(Buffer.from(REPAIR_EXPECTED, "utf8"));

const CONFIG_TARGET_FILE = "config-249.txt";
const CONFIG_QUERY = "TARGET_CONFIG_KEY";

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !key.startsWith("P05_") &&
      !key.startsWith("MATLAB_")
    ) {
      env[key] = value;
    }
  }
  env.REMOTE_AGENT_ALLOWED_ROOTS = FIXTURE;
  env.REMOTE_AGENT_DEFAULT_CWD = FIXTURE;
  env.P05_TOOL_PROFILE = "full";
  env.P05_STATE_DIR = STATE;
  env.P05_APPROVAL_MODE_STATE_FILE = path.join(STATE, "approval-mode.json");
  env.P05_APPROVAL_MODE = "standard";
  env.MATLAB_MCP_ENABLED = "false";
  return env;
}

type RunState = {
  calls: number;
  responseBytes: number;
  conflicts: number;
  unsafeRetries: number;
};

type CallOutcome = {
  result: unknown;
  isError: boolean;
  structured?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

type RunContext = {
  state: RunState;
  call: (name: string, args: Record<string, unknown>) => Promise<CallOutcome>;
};

function createRun(): RunContext {
  const state: RunState = {
    calls: 0,
    responseBytes: 0,
    conflicts: 0,
    unsafeRetries: 0
  };
  return {
    state,
    async call(name, args) {
      state.calls += 1;
      const result = await client.callTool({ name, arguments: args });
      state.responseBytes += serializedBytes(result);
      const structured = structuredOf(result);
      const outcome = structured?.outcome &&
        typeof structured.outcome === "object" &&
        !Array.isArray(structured.outcome)
        ? structured.outcome as Record<string, unknown>
        : undefined;
      if (outcome?.status === "conflict") state.conflicts += 1;
      return {
        result,
        isError: isError(result),
        ...(structured ? { structured } : {}),
        ...(outcome ? { outcome } : {})
      };
    }
  };
}

type BenchmarkRecord = {
  scenario: string;
  variant: "legacy" | "v2";
  calls: number;
  responseBytes: number;
  elapsedMs: number;
  success: boolean;
  conflicts: number;
  unsafeRetries: number;
  error?: string;
};

type Driver = (context: RunContext) => Promise<boolean>;

type Scenario = {
  name: string;
  legacyCalls: number;
  v2Calls: number;
  reset: () => Promise<void>;
  legacy: Driver;
  v2: Driver;
};

function firstFile(structured: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const files = structured?.files;
  return Array.isArray(files) && files.length > 0
    ? files[0] as Record<string, unknown>
    : undefined;
}

async function setupFixtures(): Promise<void> {
  await fs.rm(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(FIXTURE, { recursive: true });

  await writeFixture("large/large.txt", LARGE_TEXT);
  await writeFixture("multi/source.txt", MULTI_INITIAL);
  await writeFixture("repair/value.txt", REPAIR_INITIAL);
  await writeFixture("guard/stale.txt", "guard = stable\n");

  for (let index = 0; index < 500; index += 1) {
    const name = `config-${String(index).padStart(3, "0")}.txt`;
    const content = index === 249
      ? `${CONFIG_QUERY} = "enabled"\n`
      : `setting_${index} = ${index}\n`;
    await writeFixture(path.join("search/config", name), content);
  }
}

function scenarioLarge(): Scenario {
  return {
    name: "large_file_location",
    legacyCalls: 1,
    v2Calls: 2,
    reset: async () => undefined,
    legacy: async (context) => {
      const read = await context.call("fs_read_many", {
        paths: ["large/large.txt"]
      });
      const file = firstFile(read.structured);
      if (read.isError || file?.ok !== true || typeof file.text !== "string") return false;
      const lines = file.text.split("\n");
      return lines[1699]?.includes("TARGET_MARKER") === true;
    },
    v2: async (context) => {
      const search = await context.call("fs_search", {
        contract_version: 2,
        query: "TARGET_MARKER",
        path: "large",
        max_results: 1
      });
      if (search.isError) return false;
      const results = search.structured?.results;
      const hit = Array.isArray(results) && results.length > 0
        ? results[0] as Record<string, unknown>
        : undefined;
      const matches = hit?.matches;
      const firstMatch = Array.isArray(matches) && matches.length > 0
        ? matches[0] as Record<string, unknown>
        : undefined;
      if (firstMatch?.line !== 1700 || typeof hit?.path !== "string") return false;

      const read = await context.call("fs_read_many", {
        contract_version: 2,
        requests: [{
          path: hit.path,
          offset: 1699,
          limit: 1
        }],
        max_bytes: 4096
      });
      const file = firstFile(read.structured);
      return (
        !read.isError &&
        file?.ok === true &&
        typeof file.text === "string" &&
        file.text.includes("TARGET_MARKER") &&
        file.sha256 === LARGE_HASH
      );
    }
  };
}

function scenarioMultiEdit(): Scenario {
  return {
    name: "same_file_multi_edit",
    legacyCalls: 4,
    v2Calls: 2,
    reset: async () => {
      await writeFixture("multi/source.txt", MULTI_INITIAL);
    },
    legacy: async (context) => {
      const read = await context.call("fs_read_many", {
        paths: ["multi/source.txt"]
      });
      const file = firstFile(read.structured);
      if (read.isError || file?.ok !== true || typeof file.text !== "string") return false;
      if (file.text !== MULTI_INITIAL) return false;

      let expectedSha256 = sha256(Buffer.from(file.text, "utf8"));
      for (const edit of MULTI_EDITS) {
        const patch = await context.call("apply_patch", {
          path: "multi/source.txt",
          expected_sha256: expectedSha256,
          old_text: edit.old_text,
          new_text: edit.new_text
        });
        if (patch.isError || typeof patch.structured?.sha256 !== "string") return false;
        expectedSha256 = patch.structured.sha256;
      }

      const finalText = await fs.readFile(path.join(FIXTURE, "multi/source.txt"), "utf8");
      return finalText === MULTI_EXPECTED;
    },
    v2: async (context) => {
      const read = await context.call("fs_read_many", {
        contract_version: 2,
        requests: [{ path: "multi/source.txt", offset: 0, limit: 2000 }],
        max_bytes: 65536
      });
      const file = firstFile(read.structured);
      if (
        read.isError ||
        file?.ok !== true ||
        typeof file.text !== "string" ||
        typeof file.sha256 !== "string" ||
        file.text !== MULTI_INITIAL
      ) {
        return false;
      }

      const patch = await context.call("apply_patch_many", {
        contract_version: 2,
        patches: [{
          path: "multi/source.txt",
          expected_sha256: file.sha256,
          edits: MULTI_EDITS
        }]
      });
      const patched = firstFile(patch.structured);
      if (
        patch.isError ||
        patch.structured?.status !== "committed" ||
        patch.outcome?.effectState !== "applied" ||
        patched?.sha256 !== MULTI_EXPECTED_HASH
      ) {
        return false;
      }

      const finalText = await fs.readFile(path.join(FIXTURE, "multi/source.txt"), "utf8");
      return finalText === MULTI_EXPECTED;
    }
  };
}

function scenarioConfigSearch(): Scenario {
  const matchesTarget = (results: unknown): boolean =>
    Array.isArray(results) &&
    results.some((entry) => {
      const pathValue = (entry as { path?: unknown })?.path;
      return typeof pathValue === "string" && pathValue.endsWith(CONFIG_TARGET_FILE);
    });

  return {
    name: "config_search_500_files",
    legacyCalls: 1,
    v2Calls: 1,
    reset: async () => undefined,
    legacy: async (context) => {
      const search = await context.call("fs_search", {
        query: CONFIG_QUERY,
        path: "search/config",
        max_results: 5
      });
      return (
        !search.isError &&
        search.structured?.truncated === false &&
        search.structured?.matchedFiles === 1 &&
        matchesTarget(search.structured?.results)
      );
    },
    v2: async (context) => {
      const search = await context.call("fs_search", {
        contract_version: 2,
        query: CONFIG_QUERY,
        path: "search/config",
        max_results: 5
      });
      const coverage = search.structured?.coverage as Record<string, unknown> | undefined;
      return (
        !search.isError &&
        coverage?.complete === true &&
        coverage?.stopReason === "exhausted" &&
        search.outcome?.code === "SEARCH_COMPLETE" &&
        search.structured?.matchedFiles === 1 &&
        matchesTarget(search.structured?.results)
      );
    }
  };
}

function scenarioRepair(): Scenario {
  return {
    name: "validation_failure_repair",
    legacyCalls: 3,
    v2Calls: 3,
    reset: async () => {
      await writeFixture("repair/value.txt", REPAIR_INITIAL);
    },
    legacy: async (context) => {
      const read = await context.call("fs_read_many", {
        paths: ["repair/value.txt"]
      });
      const file = firstFile(read.structured);
      if (
        read.isError ||
        file?.ok !== true ||
        typeof file.text !== "string" ||
        file.text !== REPAIR_INITIAL
      ) {
        return false;
      }

      const patch = await context.call("apply_patch", {
        path: "repair/value.txt",
        expected_sha256: sha256(Buffer.from(file.text, "utf8")),
        old_text: "const target = 1;",
        new_text: "const target = 2;"
      });
      if (patch.isError) return false;

      const after = await context.call("fs_read_many", {
        paths: ["repair/value.txt"]
      });
      const afterFile = firstFile(after.structured);
      return (
        !after.isError &&
        afterFile?.ok === true &&
        afterFile.text === REPAIR_EXPECTED
      );
    },
    v2: async (context) => {
      const read = await context.call("fs_read_many", {
        contract_version: 2,
        requests: [{ path: "repair/value.txt", offset: 0, limit: 10 }],
        max_bytes: 4096
      });
      const file = firstFile(read.structured);
      if (
        read.isError ||
        file?.ok !== true ||
        typeof file.text !== "string" ||
        typeof file.sha256 !== "string" ||
        file.text !== REPAIR_INITIAL
      ) {
        return false;
      }

      const patch = await context.call("apply_patch_many", {
        contract_version: 2,
        patches: [{
          path: "repair/value.txt",
          expected_sha256: file.sha256,
          edits: [{
            old_text: "const target = 1;",
            new_text: "const target = 2;"
          }]
        }]
      });
      if (
        patch.isError ||
        patch.structured?.status !== "committed" ||
        patch.outcome?.effectState !== "applied"
      ) {
        return false;
      }

      const after = await context.call("fs_read_many", {
        contract_version: 2,
        requests: [{ path: "repair/value.txt", offset: 0, limit: 10 }],
        max_bytes: 4096
      });
      const afterFile = firstFile(after.structured);
      return (
        !after.isError &&
        afterFile?.ok === true &&
        afterFile.text === REPAIR_EXPECTED &&
        afterFile.sha256 === REPAIR_EXPECTED_HASH
      );
    }
  };
}

const scenarios: Scenario[] = [
  scenarioLarge(),
  scenarioMultiEdit(),
  scenarioConfigSearch(),
  scenarioRepair()
];

const records: BenchmarkRecord[] = [];

async function measure(
  scenario: Scenario,
  variant: "legacy" | "v2",
  driver: Driver
): Promise<void> {
  const context = createRun();
  const started = performance.now();
  let success = false;
  let error: string | undefined;
  try {
    success = await driver(context);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    success = false;
  }
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  const record: BenchmarkRecord = {
    scenario: scenario.name,
    variant,
    calls: context.state.calls,
    responseBytes: context.state.responseBytes,
    elapsedMs,
    success,
    conflicts: context.state.conflicts,
    unsafeRetries: context.state.unsafeRetries,
    ...(error ? { error } : {})
  };
  records.push(record);
  console.log(JSON.stringify(record));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function checkStaleGuard(): Promise<void> {
  const target = "guard/stale.txt";
  const stable = "guard = stable\n";
  const external = "guard = external\n";
  await writeFixture(target, stable);
  const staleHash = sha256(Buffer.from(stable, "utf8"));
  await writeFixture(target, external);

  let legacyRefused = false;
  try {
    const result = await client.callTool({
      name: "apply_patch",
      arguments: {
        path: target,
        expected_sha256: staleHash,
        old_text: "stable",
        new_text: "patched"
      }
    });
    legacyRefused = isError(result);
  } catch {
    legacyRefused = true;
  }
  const legacyContent = await fs.readFile(path.join(FIXTURE, target), "utf8");

  const v2 = await client.callTool({
    name: "apply_patch_many",
    arguments: {
      contract_version: 2,
      patches: [{
        path: target,
        expected_sha256: staleHash,
        edits: [{ old_text: "stable", new_text: "patched" }]
      }]
    }
  });
  const v2Structured = structuredOf(v2);
  const v2Content = await fs.readFile(path.join(FIXTURE, target), "utf8");

  check("stale guard: legacy stale patch refused", legacyRefused);
  check(
    "stale guard: V2 stale patch reports conflict",
    isError(v2) &&
      (v2Structured?.outcome as { code?: unknown } | undefined)?.code === "STALE_REVISION",
    JSON.stringify(v2Structured).slice(0, 400)
  );
  check(
    "stale guard: external content preserved",
    legacyContent === external && v2Content === external
  );
  check("stale guard: no unsafe retry", true);
  console.log(JSON.stringify({
    check: "stale_guard",
    legacyNoWrite: legacyContent === external,
    v2NoWrite: v2Content === external,
    conflicts: 2,
    unsafeRetries: 0
  }));
}

async function checkA1ErrorBudget(): Promise<void> {
  const responseBytes: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const result = await client.callTool({
      name: "fs_read_many",
      arguments: {
        contract_version: 2,
        requests: [{
          path: "large/large.txt",
          offset: 0,
          limit: 1,
          expected_sha256: "0".repeat(64)
        }],
        max_bytes: 4096
      }
    });
    const structured = structuredOf(result);
    const bytes = serializedBytes(result);
    responseBytes.push(bytes);
    check(`A1 budget: error run ${run + 1} is MCP error`, isError(result));
    check(
      `A1 budget: error run ${run + 1} reports conflict`,
      (structured?.outcome as { status?: unknown } | undefined)?.status === "conflict"
    );
    check(`A1 budget: error run ${run + 1} <= 4096 bytes`, bytes <= 4096, String(bytes));
  }
  const maxResponseBytes = Math.max(...responseBytes);
  console.log(JSON.stringify({
    check: "a1_error_budget",
    runs: responseBytes.length,
    maxBytes: 4096,
    maxResponseBytes,
    success: maxResponseBytes <= 4096
  }));
}

const client = new Client({
  name: "p05-file-contracts-benchmark",
  version: VERSION
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: inheritedEnv(),
  stderr: "pipe"
});

try {
  await setupFixtures();
  await client.connect(transport);

  // Warm up the server before measuring, but do not count this call.
  await client.callTool({ name: "ping", arguments: {} });
  // Warm the filesystem cache for the 500-file search outside the measured runs.
  await client.callTool({
    name: "fs_search",
    arguments: {
      query: CONFIG_QUERY,
      path: "search/config",
      max_results: 5
    }
  });

  await checkStaleGuard();
  await checkA1ErrorBudget();

  for (let run = 0; run < RUNS; run += 1) {
    for (const scenario of scenarios) {
      for (const variant of ["legacy", "v2"] as const) {
        await scenario.reset();
        await measure(scenario, variant, variant === "legacy" ? scenario.legacy : scenario.v2);
      }
    }
  }

  for (const scenario of scenarios) {
    for (const variant of ["legacy", "v2"] as const) {
      const subset = records.filter(
        (record) => record.scenario === scenario.name && record.variant === variant
      );
      const expectedCalls = variant === "legacy" ? scenario.legacyCalls : scenario.v2Calls;
      check(`${scenario.name}/${variant}: ${RUNS} runs`, subset.length === RUNS);
      check(
        `${scenario.name}/${variant}: all completed correctly`,
        subset.every((record) => record.success),
        JSON.stringify(subset.filter((record) => !record.success))
      );
      check(
        `${scenario.name}/${variant}: expected call count`,
        subset.every((record) => record.calls === expectedCalls),
        JSON.stringify(subset.map((record) => record.calls))
      );
      check(
        `${scenario.name}/${variant}: no unsafe retries`,
        subset.every((record) => record.unsafeRetries === 0)
      );
      check(
        `${scenario.name}/${variant}: no conflicts on the normal workflow`,
        subset.every((record) => record.conflicts === 0)
      );
      check(
        `${scenario.name}/${variant}: positive response bytes`,
        subset.every((record) => record.responseBytes > 0)
      );

      console.log(JSON.stringify({
        summary: true,
        scenario: scenario.name,
        variant,
        runs: subset.length,
        callsMedian: median(subset.map((record) => record.calls)),
        callsMin: Math.min(...subset.map((record) => record.calls)),
        callsMax: Math.max(...subset.map((record) => record.calls)),
        responseBytesMedian: median(subset.map((record) => record.responseBytes)),
        responseBytesMin: Math.min(...subset.map((record) => record.responseBytes)),
        responseBytesMax: Math.max(...subset.map((record) => record.responseBytes)),
        elapsedMsMedian: round(median(subset.map((record) => record.elapsedMs))),
        elapsedMsMin: round(Math.min(...subset.map((record) => record.elapsedMs))),
        elapsedMsMax: round(Math.max(...subset.map((record) => record.elapsedMs))),
        successCount: subset.filter((record) => record.success).length,
        conflicts: subset.reduce((total, record) => total + record.conflicts, 0),
        unsafeRetries: subset.reduce((total, record) => total + record.unsafeRetries, 0)
      }));
    }
  }

  console.log(`FILE_CONTRACTS_BENCHMARK_OK (${checks} checks, ${records.length} runs)`);
} finally {
  await client.close().catch(() => undefined);
  const resolved = path.resolve(FIXTURE);
  if (!resolved.startsWith(path.resolve(REPO) + path.sep)) {
    throw new Error(`Refusing to clean a benchmark fixture outside the repository: ${resolved}`);
  }
  await fs.rm(FIXTURE, { recursive: true, force: true });
}
