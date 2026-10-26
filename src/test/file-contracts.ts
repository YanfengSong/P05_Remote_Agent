/**
 * V2 file-contract checks: versioned range reads, strict decoding, raw-byte hashes,
 * bounded MCP responses and backward compatibility.
 *
 * Run: node dist/test/file-contracts.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_file_contracts_test");
const OUTSIDE = path.join(REPO, "_p05_file_contracts_outside");
const LINK = path.join(FIXTURE, "escape-link");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}
function checkEqual(label: string, actual: unknown, expected: unknown): void {
  checks += 1;
  assert.deepEqual(actual, expected, label);
}
function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixture(name: string, value: string | Buffer): Promise<string> {
  const target = path.join(FIXTURE, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}

async function captureReadError(fn: () => Promise<unknown>): Promise<{
  code: string;
  message: string;
  sha256?: string;
  totalLines?: number;
}> {
  try {
    await fn();
  } catch (error) {
    check(
      "error type: ReadRangeError",
      error instanceof ReadRangeError,
      error instanceof Error ? error.message : String(error)
    );
    if (error instanceof ReadRangeError) {
      check(
        "error message: no resolved host path",
        !error.message.includes(FIXTURE) && !error.message.includes(OUTSIDE),
        error.message
      );
      return {
        code: error.code,
        message: error.message,
        ...(error.sha256 ? { sha256: error.sha256 } : {}),
        ...(error.totalLines !== undefined ? { totalLines: error.totalLines } : {})
      };
    }
    return { code: "UNKNOWN", message: String(error) };
  }
  throw new Error("FAIL expected a ReadRangeError, nothing was thrown");
}

async function expectReadError(
  label: string,
  fn: () => Promise<unknown>,
  expectedCode: string | readonly string[]
): Promise<Awaited<ReturnType<typeof captureReadError>>> {
  const failure = await captureReadError(fn);
  const expected = typeof expectedCode === "string" ? [expectedCode] : expectedCode;
  check(`${label}: code ${expected.join("|")}`, expected.includes(failure.code), failure.message);
  return failure;
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.rm(OUTSIDE, { recursive: true, force: true });
await fs.mkdir(FIXTURE, { recursive: true });
await fs.mkdir(OUTSIDE, { recursive: true });

// Set the process environment before importing modules that assemble config at import time.
process.env.REMOTE_AGENT_ALLOWED_ROOTS = FIXTURE;
process.env.REMOTE_AGENT_DEFAULT_CWD = FIXTURE;
process.env.REMOTE_AGENT_MAX_READ_BYTES = String(16 * 1024 * 1024);

const {
  READ_LIMITS,
  fsReadManyInputSchema,
  fsReadManyOutputSchema
} = await import("../tools/file-contracts.js");
const {
  ReadRangeError,
  readManyRanges,
  readRange,
  resolveReadLimit,
  splitLines
} = await import("../tools/read-ranges.js");
const { serializedBytes, toolResultBytes } = await import("../tools/result-budget.js");
const { patchTextFile } = await import("../tools/files.js");

try {
  // ---------------------------------------------------------------- pure helpers
  checkEqual("splitLines: empty file", splitLines(""), []);
  checkEqual("splitLines: trailing newline", splitLines("a\n"), ["a\n"]);
  checkEqual("splitLines: CRLF preserved", splitLines("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
  checkEqual("splitLines: no final newline", splitLines("a\nb"), ["a\n", "b"]);
  checkEqual("splitLines: blank line", splitLines("a\n\n"), ["a\n", "\n"]);
  checkEqual("splitLines: only newline", splitLines("\n"), ["\n"]);

  checkEqual(
    "serializedBytes: UTF-8 JSON bytes",
    serializedBytes({ text: "中" }),
    Buffer.byteLength('{"text":"中"}', "utf8")
  );
  checkEqual(
    "serializedBytes: tool result includes duplicated body",
    toolResultBytes({ text: "中" }, "中"),
    serializedBytes({
      content: [{ type: "text", text: "中" }],
      structuredContent: { text: "中" }
    })
  );

  // ---------------------------------------------------------------- input schema
  const request = { path: "plain.txt", offset: 0, limit: 1 };
  check("schema: legacy paths accepted", fsReadManyInputSchema.safeParse({ paths: ["plain.txt"] }).success);
  check(
    "schema: V2 requests accepted",
    fsReadManyInputSchema.safeParse({ contract_version: 2, requests: [request] }).success
  );
  check(
    "schema: paths and requests are mutually exclusive",
    !fsReadManyInputSchema.safeParse({ paths: ["plain.txt"], requests: [request] }).success
  );
  check(
    "schema: requests require contract_version 2",
    !fsReadManyInputSchema.safeParse({ requests: [request] }).success
  );
  check(
    "schema: legacy paths reject contract_version",
    !fsReadManyInputSchema.safeParse({ contract_version: 2, paths: ["plain.txt"] }).success
  );
  check(
    "schema: legacy paths reject max_bytes",
    !fsReadManyInputSchema.safeParse({ paths: ["plain.txt"], max_bytes: 4096 }).success
  );
  check(
    "schema: 21 requests rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: Array.from({ length: 21 }, () => request)
    }).success
  );
  check(
    "schema: zero requests rejected",
    !fsReadManyInputSchema.safeParse({ contract_version: 2, requests: [] }).success
  );
  check(
    "schema: 21 legacy paths rejected",
    !fsReadManyInputSchema.safeParse({ paths: Array.from({ length: 21 }, () => "plain.txt") }).success
  );
  check(
    "schema: negative offset rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, offset: -1 }]
    }).success
  );
  check(
    "schema: limit zero rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, limit: 0 }]
    }).success
  );
  check(
    "schema: limit above 2000 rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, limit: 2001 }]
    }).success
  );
  check(
    "schema: max_bytes below 4096 rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [request],
      max_bytes: READ_LIMITS.minMaxBytes - 1
    }).success
  );
  check(
    "schema: max_bytes above 256 KiB rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [request],
      max_bytes: READ_LIMITS.maxMaxBytes + 1
    }).success
  );
  check(
    "schema: minimum and maximum max_bytes accepted",
    fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [request],
      max_bytes: READ_LIMITS.minMaxBytes
    }).success &&
      fsReadManyInputSchema.safeParse({
        contract_version: 2,
        requests: [request],
        max_bytes: READ_LIMITS.maxMaxBytes
      }).success
  );
  check(
    "schema: 1024-character request path accepted",
    fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, path: "a".repeat(READ_LIMITS.maxPathChars) }]
    }).success
  );
  check(
    "schema: 1025-character request path rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, path: "a".repeat(READ_LIMITS.maxPathChars + 1) }]
    }).success
  );
  check(
    "schema: malformed expected_sha256 rejected",
    !fsReadManyInputSchema.safeParse({
      contract_version: 2,
      requests: [{ ...request, expected_sha256: "abc" }]
    }).success
  );

  // ---------------------------------------------------------------- fixtures
  const plainText = "alpha\nbeta\ngamma\n";
  const plainRaw = Buffer.from(plainText, "utf8");
  await writeFixture("plain.txt", plainRaw);
  await writeFixture("empty.txt", "");
  const trailingText = "one\ntwo\n";
  await writeFixture("trailing.txt", trailingText);
  const crlfText = "a\r\nb\r\nc\r\n";
  const crlfRaw = Buffer.from(crlfText, "utf8");
  await writeFixture("crlf.txt", crlfRaw);
  const chineseText = "第一行\n第二行\n第三行\n";
  await writeFixture("chinese.txt", chineseText);
  const bomRaw = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("alpha\nbeta\n", "utf8")
  ]);
  await writeFixture("bom.txt", bomRaw);
  await writeFixture("invalid.txt", Buffer.from([0x41, 0xff, 0x42]));
  await writeFixture("binary.txt", Buffer.from([0x41, 0x00, 0x42]));
  await writeFixture("single-line.txt", "x".repeat(8000));
  await writeFixture("oversized.txt", Buffer.alloc(READ_LIMITS.maxFileBytes + 1, 0x61));

  const manyLines = Array.from(
    { length: 2000 },
    (_, index) => `line-${String(index + 1).padStart(4, "0")} ${"x".repeat(20)}\n`
  );
  await writeFixture("many-lines.txt", manyLines.join(""));

  const chineseLines = Array.from(
    { length: 200 },
    (_, index) => `第${index + 1}行 "引号" \\ 反斜杠 ${"中".repeat(10)}\n`
  );
  await writeFixture("chinese-lines.txt", chineseLines.join(""));

  const paginationLines = Array.from(
    { length: 20 },
    (_, index) => `row-${String(index + 1).padStart(2, "0")}\n`
  );
  const paginationPath = await writeFixture("pagination.txt", paginationLines.join(""));
  await fs.mkdir(path.join(FIXTURE, "directory"), { recursive: true });
  await writeFixture(".env", "SECRET=must-not-be-readable\n");
  const outsideSecret = path.join(OUTSIDE, "secret.txt");
  await fs.writeFile(outsideSecret, "outside-secret\n", "utf8");

  // ---------------------------------------------------------------- range reads
  const first = await readRange(FIXTURE, { path: "plain.txt", offset: 0, limit: 2 });
  checkEqual("read: raw-byte sha256", first.sha256, sha256(plainRaw));
  checkEqual("read: totalLines", first.totalLines, 3);
  checkEqual("read: offset", first.offset, 0);
  checkEqual("read: returnedLines", first.returnedLines, 2);
  checkEqual("read: 1-based lineStart", first.lineStart, 1);
  checkEqual("read: 1-based lineEnd", first.lineEnd, 2);
  checkEqual("read: text", first.text, "alpha\nbeta\n");
  checkEqual("read: complete", first.complete, false);
  checkEqual("read: nextOffset", first.nextOffset, 2);

  const last = await readRange(FIXTURE, {
    path: "plain.txt",
    offset: first.nextOffset!,
    limit: 10,
    expected_sha256: first.sha256.toUpperCase()
  });
  checkEqual("read: continuation text", last.text, "gamma\n");
  checkEqual("read: continuation complete", last.complete, true);
  check("read: no nextOffset when complete", last.nextOffset === undefined);

  const pastEnd = await readRange(FIXTURE, { path: "plain.txt", offset: 3, limit: 1 });
  checkEqual("read: offset at totalLines is an empty complete range", pastEnd.text, "");
  checkEqual("read: offset at totalLines returnedLines", pastEnd.returnedLines, 0);
  checkEqual("read: offset at totalLines complete", pastEnd.complete, true);

  const empty = await readRange(FIXTURE, { path: "empty.txt", offset: 0, limit: 1 });
  checkEqual("read: empty file totalLines", empty.totalLines, 0);
  checkEqual("read: empty file text", empty.text, "");
  checkEqual("read: empty file complete", empty.complete, true);
  checkEqual("read: empty file hash", empty.sha256, sha256(Buffer.alloc(0)));

  const trailing = await readRange(FIXTURE, { path: "trailing.txt", offset: 0, limit: 10 });
  checkEqual("read: trailing newline does not add a line", trailing.totalLines, 2);
  checkEqual("read: trailing newline text", trailing.text, trailingText);

  const crlf = await readRange(FIXTURE, { path: "crlf.txt", offset: 0, limit: 2 });
  checkEqual("read: CRLF preserved", crlf.text, "a\r\nb\r\n");
  checkEqual("read: CRLF hash is raw bytes", crlf.sha256, sha256(crlfRaw));

  const chinese = await readRange(FIXTURE, { path: "chinese.txt", offset: 1, limit: 1 });
  checkEqual("read: Chinese text", chinese.text, "第二行\n");
  checkEqual("read: Chinese totalLines", chinese.totalLines, 3);

  const bom = await readRange(FIXTURE, { path: "bom.txt", offset: 0, limit: 2 });
  checkEqual("read: BOM removed from display", bom.text, "alpha\nbeta\n");
  checkEqual("read: BOM included in hash", bom.sha256, sha256(bomRaw));

  const bomPatched = await patchTextFile("bom.txt", bom.sha256, "beta", "BETA", FIXTURE);
  const bomAfter = await fs.readFile(path.join(FIXTURE, "bom.txt"));
  check(
    "patch compatibility: BOM bytes survive a UTF-8 decode/re-encode patch",
    bomAfter.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) &&
      bomAfter.toString("utf8").endsWith("alpha\nBETA\n")
  );
  checkEqual("patch compatibility: new hash is over raw bytes", bomPatched.sha256, sha256(bomAfter));
  const bomAfterRead = await readRange(FIXTURE, { path: "bom.txt", offset: 0, limit: 2 });
  checkEqual("patch compatibility: read hash matches patch hash", bomAfterRead.sha256, bomPatched.sha256);

  const crlfPatched = await patchTextFile("crlf.txt", crlf.sha256, "a\r\n", "A\r\n", FIXTURE);
  const crlfAfter = await fs.readFile(path.join(FIXTURE, "crlf.txt"));
  checkEqual("patch compatibility: CRLF patch hash over raw bytes", crlfPatched.sha256, sha256(crlfAfter));
  check("patch compatibility: CRLF preserved after patch", crlfAfter.toString("utf8") === "A\r\nb\r\nc\r\n");

  await expectReadError(
    "read: invalid UTF-8 rejected",
    () => readRange(FIXTURE, { path: "invalid.txt", offset: 0, limit: 1 }),
    "INVALID_UTF8"
  );
  await expectReadError(
    "read: binary file rejected",
    () => readRange(FIXTURE, { path: "binary.txt", offset: 0, limit: 1 }),
    "BINARY_FILE"
  );
  await expectReadError(
    "read: missing file",
    () => readRange(FIXTURE, { path: "missing.txt", offset: 0, limit: 1 }),
    "NOT_FOUND"
  );
  await expectReadError(
    "read: directory",
    () => readRange(FIXTURE, { path: "directory", offset: 0, limit: 1 }),
    ["NOT_FILE", "IS_DIRECTORY"]
  );
  await expectReadError(
    "read: oversized file is refused before decoding",
    () => readRange(FIXTURE, { path: "oversized.txt", offset: 0, limit: 1 }),
    "READ_TOO_LARGE"
  );
  await expectReadError(
    "read: offset past the end",
    () => readRange(FIXTURE, { path: "plain.txt", offset: 4, limit: 1 }),
    "OFFSET_OUT_OF_RANGE"
  );

  const staleText = "alpha\nBETA\ngamma\n";
  await writeFixture("stale.txt", staleText);
  const staleBefore = await readRange(FIXTURE, { path: "stale.txt", offset: 0, limit: 1 });
  await writeFixture("stale.txt", "alpha\nCHANGED\ngamma\n");
  const stale = await expectReadError(
    "read: stale expected_sha256",
    () => readRange(FIXTURE, {
      path: "stale.txt",
      offset: 1,
      limit: 1,
      expected_sha256: staleBefore.sha256
    }),
    "STALE_REVISION"
  );
  checkEqual(
    "read: stale error carries the current version",
    stale.sha256,
    sha256(Buffer.from("alpha\nCHANGED\ngamma\n", "utf8"))
  );

  const pageBefore = await readRange(FIXTURE, { path: "pagination.txt", offset: 0, limit: 5 });
  const pageAfter = await readRange(FIXTURE, {
    path: "pagination.txt",
    offset: pageBefore.nextOffset!,
    limit: 5,
    expected_sha256: pageBefore.sha256
  });
  checkEqual("read: nextOffset continues the exact next lines", pageAfter.text, paginationLines.slice(5, 10).join(""));
  await writeFixture("pagination.txt", paginationLines.join("") + "row-21\n");
  await expectReadError(
    "read: file changed between pages",
    () => readRange(FIXTURE, {
      path: "pagination.txt",
      offset: pageBefore.nextOffset!,
      limit: 5,
      expected_sha256: pageBefore.sha256
    }),
    "STALE_REVISION"
  );

  // ---------------------------------------------------------------- security
  await expectReadError(
    "security: relative path outside the workspace",
    () => readRange(FIXTURE, {
      path: "../" + path.basename(OUTSIDE) + "/secret.txt",
      offset: 0,
      limit: 1
    }),
    "PATH_REFUSED"
  );
  await expectReadError(
    "security: absolute path outside the workspace",
    () => readRange(FIXTURE, { path: outsideSecret, offset: 0, limit: 1 }),
    "PATH_REFUSED"
  );
  await expectReadError(
    "security: protected .env",
    () => readRange(FIXTURE, { path: ".env", offset: 0, limit: 1 }),
    "PATH_REFUSED"
  );

  execFileSync("cmd", ["/c", "mklink", "/J", LINK, OUTSIDE], { stdio: "pipe" });
  await expectReadError(
    "security: junction resolving outside the workspace",
    () => readRange(FIXTURE, { path: "escape-link/secret.txt", offset: 0, limit: 1 }),
    "PATH_REFUSED"
  );

  // ---------------------------------------------------------------- read limits
  checkEqual("limits: configured limit is respected", resolveReadLimit(2 * 1024 * 1024), 2 * 1024 * 1024);
  checkEqual(
    "limits: hard 8 MiB cap",
    resolveReadLimit(16 * 1024 * 1024),
    READ_LIMITS.maxFileBytes
  );
  checkEqual("limits: default configured cap is 8 MiB", resolveReadLimit(), READ_LIMITS.maxFileBytes);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    try {
      resolveReadLimit(invalid);
      check(`limits: invalid ${String(invalid)} rejected`, false);
    } catch (error) {
      check(
        `limits: invalid ${String(invalid)} fails closed`,
        error instanceof ReadRangeError && error.code === "READ_LIMIT_INVALID",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // ---------------------------------------------------------------- batch behavior
  const partial = await readManyRanges(
    FIXTURE,
    [
      { path: "plain.txt", offset: 0, limit: 3 },
      { path: "missing.txt", offset: 0, limit: 1 },
      { path: "chinese.txt", offset: 0, limit: 3 }
    ],
    READ_LIMITS.defaultMaxBytes
  );
  checkEqual("batch: per-file success and failure", [partial.result.successCount, partial.result.failureCount], [2, 1]);
  checkEqual("batch: independent files still return", partial.result.files.length, 3);
  checkEqual("batch: first file ok", partial.result.files[0]?.ok, true);
  checkEqual("batch: failed file code", partial.result.files[1]?.errorCode, "NOT_FOUND");
  checkEqual("batch: third file ok", partial.result.files[2]?.ok, true);
  checkEqual("batch: partial outcome", partial.result.outcome.status, "partial");
  checkEqual("batch: no pending requests", partial.result.pendingIndexes, []);
  check("batch: text client sees body", partial.contentText.includes("alpha\nbeta\ngamma\n"));
  check("batch: text client sees Chinese body", partial.contentText.includes("第三行\n"));
  check("batch: text client sees version", partial.contentText.includes(first.sha256));
  check(
    "batch: response budget includes content and structuredContent",
    toolResultBytes(partial.result, partial.contentText) <= READ_LIMITS.defaultMaxBytes
  );

  const budget = await readManyRanges(
    FIXTURE,
    [
      { path: "many-lines.txt", offset: 0, limit: 2000 },
      { path: "plain.txt", offset: 0, limit: 3 },
      { path: "chinese.txt", offset: 0, limit: 3 }
    ],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("budget: one item returned", budget.result.files.length, 1);
  checkEqual("budget: later indexes pending", budget.result.pendingIndexes, [1, 2]);
  const budgetFirst = budget.result.files[0]!;
  checkEqual("budget: first item ok", budgetFirst.ok, true);
  check("budget: first item was trimmed", (budgetFirst.returnedLines ?? 0) > 0 && (budgetFirst.returnedLines ?? 0) < 2000);
  checkEqual("budget: nextOffset advances", budgetFirst.nextOffset, budgetFirst.returnedLines);
  checkEqual("budget: complete is false", budgetFirst.complete, false);
  checkEqual("budget: outcome partial", budget.result.outcome.status, "partial");
  checkEqual("budget: outcome code", budget.result.outcome.code, "READ_TRUNCATED");
  check(
    "budget: selected max_bytes respected",
    toolResultBytes(budget.result, budget.contentText) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(budget.result, budget.contentText))
  );
  check("budget: text client sees nextOffset", budget.contentText.includes("nextOffset="));
  check("budget: text client sees pending indexes", budget.contentText.includes("pendingIndexes: [1, 2]"));

  const nextPage = await readManyRanges(
    FIXTURE,
    [{
      path: "many-lines.txt",
      offset: budgetFirst.nextOffset!,
      limit: 2000,
      expected_sha256: budgetFirst.sha256!
    }],
    READ_LIMITS.minMaxBytes
  );
  const nextPageItem = nextPage.result.files[0]!;
  checkEqual("budget: next page ok", nextPageItem.ok, true);
  checkEqual(
    "budget: next page starts at the exact unreported line",
    (nextPageItem.text ?? "").split("\n")[0],
    manyLines[budgetFirst.nextOffset!]!.replace(/\n$/, "")
  );

  const defaultBudget = await readManyRanges(
    FIXTURE,
    [{ path: "many-lines.txt", offset: 0, limit: 2000 }],
    READ_LIMITS.defaultMaxBytes
  );
  const defaultItem = defaultBudget.result.files[0]!;
  check(
    "budget: default 64 KiB respects the final result size",
    toolResultBytes(defaultBudget.result, defaultBudget.contentText) <= READ_LIMITS.defaultMaxBytes,
    String(toolResultBytes(defaultBudget.result, defaultBudget.contentText))
  );
  check("budget: default trims a large range", (defaultItem.returnedLines ?? 0) < 2000);
  checkEqual("budget: default nextOffset advances", defaultItem.nextOffset, defaultItem.returnedLines);

  const maxBudget = await readManyRanges(
    FIXTURE,
    [{ path: "many-lines.txt", offset: 0, limit: 2000 }],
    READ_LIMITS.maxMaxBytes
  );
  const maxItem = maxBudget.result.files[0]!;
  check(
    "budget: 256 KiB maximum respected",
    toolResultBytes(maxBudget.result, maxBudget.contentText) <= READ_LIMITS.maxMaxBytes
  );
  checkEqual("budget: 256 KiB can return the full 2000-line range", maxItem.returnedLines, 2000);
  checkEqual("budget: 256 KiB range complete", maxItem.complete, true);

  const escapedBudget = await readManyRanges(
    FIXTURE,
    [{ path: "chinese-lines.txt", offset: 0, limit: 200 }],
    READ_LIMITS.minMaxBytes
  );
  check(
    "budget: Chinese and JSON escaping counted",
    toolResultBytes(escapedBudget.result, escapedBudget.contentText) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(escapedBudget.result, escapedBudget.contentText))
  );
  check("budget: Chinese range still makes progress", (escapedBudget.result.files[0]?.returnedLines ?? 0) > 0);

  const lineTooLarge = await readManyRanges(
    FIXTURE,
    [{ path: "single-line.txt", offset: 0, limit: 1 }],
    READ_LIMITS.minMaxBytes
  );
  const tooLargeItem = lineTooLarge.result.files[0]!;
  checkEqual("line budget: item failed", tooLargeItem.ok, false);
  checkEqual("line budget: explicit code", tooLargeItem.errorCode, "LINE_TOO_LARGE");
  check("line budget: file version still returned", Boolean(tooLargeItem.sha256));
  checkEqual("line budget: totalLines returned", tooLargeItem.totalLines, 1);
  checkEqual("line budget: no pending cursor", lineTooLarge.result.pendingIndexes, []);
  checkEqual("line budget: batch error code", lineTooLarge.result.outcome.code, "LINE_TOO_LARGE");
  check(
    "line budget: bounded error result",
    toolResultBytes(lineTooLarge.result, lineTooLarge.contentText) <= READ_LIMITS.minMaxBytes
  );

  const lineAndOther = await readManyRanges(
    FIXTURE,
    [
      { path: "single-line.txt", offset: 0, limit: 1 },
      { path: "plain.txt", offset: 0, limit: 3 }
    ],
    READ_LIMITS.minMaxBytes
  );
  checkEqual(
    "line budget: a too-large line does not block an independent file",
    [lineAndOther.result.files[0]?.errorCode, lineAndOther.result.files[1]?.ok],
    ["LINE_TOO_LARGE", true]
  );
  checkEqual("line budget: partial batch counts", [lineAndOther.result.successCount, lineAndOther.result.failureCount], [1, 1]);
  checkEqual("line budget: partial outcome", lineAndOther.result.outcome.code, "READ_PARTIAL");
  checkEqual("line budget: no pending cursor for the failed range", lineAndOther.result.pendingIndexes, []);

  const longPaths = Array.from({ length: 20 }, () => ({
    path: "\\".repeat(READ_LIMITS.maxPathChars),
    offset: 0,
    limit: 1
  }));
  const metadata = await readManyRanges(FIXTURE, longPaths, READ_LIMITS.minMaxBytes);
  checkEqual("metadata budget: fallback code", metadata.result.outcome.code, "RESULT_BUDGET_TOO_SMALL");
  checkEqual("metadata budget: no unbounded file metadata", metadata.result.files.length, 0);
  checkEqual(
    "metadata budget: all requests remain pending",
    metadata.result.pendingIndexes,
    Array.from({ length: 20 }, (_, index) => index)
  );
  check(
    "metadata budget: fixed bounded error fits",
    toolResultBytes(metadata.result, metadata.contentText) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(metadata.result, metadata.contentText))
  );
  check(
    "metadata budget: rejected paths are not echoed in the fallback",
    !JSON.stringify(metadata.result).includes("\\\\".repeat(64))
  );

  // ---------------------------------------------------------------- output schema
  check(
    "output schema: V2 result matches the advertised object",
    fsReadManyOutputSchema.safeParse(partial.result).success,
    JSON.stringify(fsReadManyOutputSchema.safeParse(partial.result).error?.issues ?? [])
  );
  check(
    "output schema: legacy result remains valid",
    fsReadManyOutputSchema.safeParse({
      files: [{ path: "plain.txt", ok: true, bytes: 5, text: "alpha" }],
      totalBytes: 5,
      successCount: 1,
      failureCount: 0
    }).success
  );

  console.log(`FILE_CONTRACTS_OK (${checks} checks)`);
} finally {
  for (const target of [FIXTURE, OUTSIDE]) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(REPO) + path.sep)) {
      throw new Error(`Refusing to clean a fixture outside the repository: ${resolved}`);
    }
  }
  await fs.rm(FIXTURE, { recursive: true, force: true });
  await fs.rm(OUTSIDE, { recursive: true, force: true });
}
