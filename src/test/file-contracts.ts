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
import { fileURLToPath, pathToFileURL } from "node:url";

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

function expectPatchEditError(
  label: string,
  fn: () => unknown,
  expectedCode: string,
  pattern: RegExp
): void {
  try {
    fn();
  } catch (error) {
    check(
      label,
      error instanceof PatchEditError &&
        error.code === expectedCode &&
        pattern.test(error.message),
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  throw new Error(`FAIL ${label} -> expected a PatchEditError`);
}

async function expectRejects(
  label: string,
  fn: () => Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, pattern.test(message), message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected rejection`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  PATCH_LIMITS,
  READ_LIMITS,
  applyPatchManyInputSchema,
  applyPatchManyOutputSchema,
  fsReadManyInputSchema,
  fsReadManyOutputSchema,
  fsSearchInputSchema,
  fsSearchOutputSchema,
  isOutcomeFailure,
  outcomeFor
} = await import("../tools/file-contracts.js");
const {
  ReadRangeError,
  readManyRanges,
  readRange,
  resolveRangeLimit,
  resolveReadLimit,
  splitLines
} = await import("../tools/read-ranges.js");
const { serializedBytes, toolResultBytes } = await import("../tools/result-budget.js");
const { PatchEditError, applyEditsToText, summarizeEdits } = await import("../tools/patch-edits.js");
const { withWriteLocks, canonicalWriteKey } = await import("../tools/file-write-lock.js");
const { selectLineWindow, iterateLines } = await import("../tools/text-lines.js");
const { config } = await import("../config.js");
const {
  patchTextFile,
  patchTextFilesBatch,
  patchTextFilesBatchV2,
  finalizeSearchResponse,
  renderPatchBatchContent,
  renderSearchContent,
  searchTextFiles,
  searchTextFilesV2,
  writeTextFile,
  writeTextFilesBatch
} = await import("../tools/files.js");
const { AuditStore } = await import("../audit/store.js");
const { ExecutionRuntime } = await import("../runtime/execution.js");
const { registerFsTools } = await import("../tools/register-fs.js");
const { setPatchCommitHooksForTests } = await import("../tools/files.js");
const { canonicalTraceTarget, metricsFor } = await import("./retry-metrics.js");

try {
  // ---------------------------------------------------------------- pure helpers
  checkEqual("splitLines: empty file", splitLines(""), []);
  checkEqual("splitLines: trailing newline", splitLines("a\n"), ["a\n"]);
  checkEqual("splitLines: CRLF preserved", splitLines("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
  checkEqual("splitLines: no final newline", splitLines("a\nb"), ["a\n", "b"]);
  checkEqual("splitLines: blank line", splitLines("a\n\n"), ["a\n", "\n"]);
  checkEqual("splitLines: only newline", splitLines("\n"), ["\n"]);

  const denseWindow = selectLineWindow("\n".repeat(200_000), 199_998, 2);
  checkEqual("text-lines: dense newline totalLines", denseWindow.totalLines, 200_000);
  checkEqual("text-lines: dense newline returnedLines", denseWindow.returnedLines, 2);
  checkEqual("text-lines: dense newline text", denseWindow.text, "\n\n");
  checkEqual(
    "text-lines: empty file",
    selectLineWindow("", 0, 10),
    { totalLines: 0, text: "", returnedLines: 0 }
  );
  checkEqual(
    "text-lines: trailing newline does not add a line",
    selectLineWindow("a\n", 0, 1),
    { totalLines: 1, text: "a\n", returnedLines: 1 }
  );
  checkEqual(
    "text-lines: CRLF window",
    selectLineWindow("a\r\nb\r\n", 1, 1),
    { totalLines: 2, text: "b\r\n", returnedLines: 1 }
  );
  checkEqual(
    "text-lines: final line without newline",
    selectLineWindow("a\nb", 1, 1),
    { totalLines: 2, text: "b", returnedLines: 1 }
  );
  checkEqual(
    "text-lines: Chinese window",
    selectLineWindow("第一行\n第二行\n", 1, 1),
    { totalLines: 2, text: "第二行\n", returnedLines: 1 }
  );
  checkEqual(
    "text-lines: iterator retains newlines",
    [...iterateLines("a\r\nb")],
    ["a\r\n", "b"]
  );

  const textLinesModule = pathToFileURL(
    path.join(REPO, "dist", "tools", "text-lines.js")
  ).href;
  const stressCode = `
const { selectLineWindow } = await import(${JSON.stringify(textLinesModule)});
const value = String.fromCharCode(10).repeat(8 * 1024 * 1024);
const window = selectLineWindow(value, 8 * 1024 * 1024 - 2, 2);
if (window.totalLines !== 8 * 1024 * 1024 || window.returnedLines !== 2 || window.text !== String.fromCharCode(10).repeat(2)) {
  throw new Error("dense newline window mismatch");
}
console.log("TEXT_LINES_STRESS_OK");
`;
  const stressOutput = execFileSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", stressCode],
    { cwd: REPO, stdio: "pipe" }
  ).toString("utf8");
  check(
    "text-lines: 8 MiB dense newline fixture completes under a 64 MiB heap",
    stressOutput.includes("TEXT_LINES_STRESS_OK"),
    stressOutput.slice(0, 200)
  );

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

  // ---------------------------------------------------------------- outcome mapping
  const staleOutcome = outcomeFor("STALE_REVISION");
  checkEqual("outcome: stale is conflict", staleOutcome.status, "conflict");
  checkEqual("outcome: stale has no effect", staleOutcome.effectState, "none");
  checkEqual("outcome: stale asks for refresh", staleOutcome.retry, "after_refresh");
  const unknownOutcome = outcomeFor("ROLLBACK_UNCONFIRMED");
  checkEqual("outcome: rollback unknown status", unknownOutcome.status, "unknown");
  checkEqual("outcome: rollback unknown effect", unknownOutcome.effectState, "unknown");
  checkEqual("outcome: rollback unknown retry", unknownOutcome.retry, "never_automatic");
  checkEqual("outcome: read truncation is partial", outcomeFor("READ_TRUNCATED").status, "partial");
  checkEqual("outcome: read truncation is not an error", isOutcomeFailure(outcomeFor("READ_TRUNCATED")), false);
  checkEqual("outcome: read partial is a failure", isOutcomeFailure(outcomeFor("READ_PARTIAL")), true);
  checkEqual("outcome: search truncation is not an error", isOutcomeFailure(outcomeFor("SEARCH_TRUNCATED")), false);
  checkEqual("outcome: search io error is a failure", isOutcomeFailure(outcomeFor("SEARCH_IO_ERROR")), true);
  const unknownCode = outcomeFor("SOMETHING_NEW");
  checkEqual("outcome: unknown write code status", unknownCode.status, "unknown");
  checkEqual("outcome: unknown write code effect", unknownCode.effectState, "unknown");
  checkEqual("outcome: unknown write code retry", unknownCode.retry, "never_automatic");
  checkEqual("outcome: unknown write code is a failure", isOutcomeFailure(unknownCode), true);
  checkEqual("outcome: path refusal is policy-like", outcomeFor("PATH_REFUSED").retry, "never_automatic");

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
  const oversizedPath = await writeFixture("oversized.txt", "");
  await fs.truncate(oversizedPath, READ_LIMITS.maxRangeFileBytes + 1);
  const largeRangeLines = Array.from(
    { length: 60000 },
    (_, index) => `large-${String(index + 1).padStart(5, "0")} ${"z".repeat(40)}\n`
  );
  const largeRangeText = largeRangeLines.join("");
  await writeFixture("large-range.txt", largeRangeText);

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

  const savedSnapshotLimit = config.maxReadBytes;
  const savedRangeLimit = config.maxRangeReadBytes;
  config.maxReadBytes = 2 * 1024 * 1024;
  config.maxRangeReadBytes = 64 * 1024 * 1024;
  try {
    checkEqual("large range: snapshot limit for streaming test", resolveReadLimit(), 2 * 1024 * 1024);
    check(
      "range limit: default allows streamed files beyond the snapshot cap",
      resolveRangeLimit() > READ_LIMITS.maxFileBytes
    );
    const largeRangeTail = await readRange(FIXTURE, {
      path: "large-range.txt",
      offset: 59997,
      limit: 2
    });
    checkEqual("large range: totalLines", largeRangeTail.totalLines, 60000);
    checkEqual("large range: returnedLines", largeRangeTail.returnedLines, 2);
    checkEqual(
      "large range: selected text",
      largeRangeTail.text,
      largeRangeLines.slice(59997, 59999).join("")
    );
    checkEqual("large range: raw hash", largeRangeTail.sha256, sha256(Buffer.from(largeRangeText, "utf8")));
    check("large range: not complete at tail request", largeRangeTail.complete === false && largeRangeTail.nextOffset === 59999);

    const largeRangeHead = await readRange(FIXTURE, {
      path: "large-range.txt",
      offset: 0,
      limit: 2
    });
    checkEqual("large range: head text", largeRangeHead.text, largeRangeLines.slice(0, 2).join(""));
    checkEqual("large range: head is not complete", largeRangeHead.complete, false);
    checkEqual("large range: head nextOffset", largeRangeHead.nextOffset, 2);

    config.maxRangeReadBytes = 1024;
    await expectReadError(
      "large range: configured streaming cap is enforced",
      () => readRange(FIXTURE, { path: "large-range.txt", offset: 0, limit: 1 }),
      "READ_TOO_LARGE"
    );
  } finally {
    config.maxReadBytes = savedSnapshotLimit;
    config.maxRangeReadBytes = savedRangeLimit;
  }

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
  checkEqual("batch: failure outcome", partial.result.outcome.status, "error");
  checkEqual("batch: failure code preserved", partial.result.outcome.code, "NOT_FOUND");
  checkEqual("batch: no pending requests", partial.result.pendingIndexes, []);
  check("batch: text client sees body", partial.contentText.includes("alpha\nbeta\ngamma\n"));
  check("batch: text client sees Chinese body", partial.contentText.includes("第三行\n"));
  check("batch: text client sees version", partial.contentText.includes(first.sha256));
  check(
    "batch: response budget includes content and structuredContent",
    toolResultBytes(
      partial.result,
      partial.contentText,
      isOutcomeFailure(partial.result.outcome)
    ) <= READ_LIMITS.defaultMaxBytes
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
    toolResultBytes(
      budget.result,
      budget.contentText,
      isOutcomeFailure(budget.result.outcome)
    ) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(
      budget.result,
      budget.contentText,
      isOutcomeFailure(budget.result.outcome)
    ))
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
    toolResultBytes(
      defaultBudget.result,
      defaultBudget.contentText,
      isOutcomeFailure(defaultBudget.result.outcome)
    ) <= READ_LIMITS.defaultMaxBytes,
    String(toolResultBytes(
      defaultBudget.result,
      defaultBudget.contentText,
      isOutcomeFailure(defaultBudget.result.outcome)
    ))
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
    toolResultBytes(
      maxBudget.result,
      maxBudget.contentText,
      isOutcomeFailure(maxBudget.result.outcome)
    ) <= READ_LIMITS.maxMaxBytes
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
    toolResultBytes(
      escapedBudget.result,
      escapedBudget.contentText,
      isOutcomeFailure(escapedBudget.result.outcome)
    ) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(
      escapedBudget.result,
      escapedBudget.contentText,
      isOutcomeFailure(escapedBudget.result.outcome)
    ))
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
    toolResultBytes(
      lineTooLarge.result,
      lineTooLarge.contentText,
      isOutcomeFailure(lineTooLarge.result.outcome)
    ) <= READ_LIMITS.minMaxBytes
  );

  const errorBudget = await readManyRanges(
    FIXTURE,
    [{ path: "missing-for-budget.txt", offset: 0, limit: 1 }],
    READ_LIMITS.minMaxBytes
  );
  checkEqual(
    "budget: A1 error outcome is a failure",
    isOutcomeFailure(errorBudget.result.outcome),
    true
  );
  check(
    "budget: A1 error response includes isError within max_bytes",
    toolResultBytes(errorBudget.result, errorBudget.contentText, true) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(errorBudget.result, errorBudget.contentText, true))
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
  checkEqual("line budget: single failure outcome", lineAndOther.result.outcome.code, "LINE_TOO_LARGE");
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
    toolResultBytes(
      metadata.result,
      metadata.contentText,
      isOutcomeFailure(metadata.result.outcome)
    ) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(
      metadata.result,
      metadata.contentText,
      isOutcomeFailure(metadata.result.outcome)
    ))
  );
  check(
    "metadata budget: rejected paths are not echoed in the fallback",
    !JSON.stringify(metadata.result).includes("\\\\".repeat(64))
  );

  // ---------------------------------------------------------------- M1 remediation regression
  const e1Name = "a".repeat(146) + ".txt";
  await writeFixture(e1Name, "x".repeat(1329) + "\n" + "x\n".repeat(35));
  const e1Reply = await readManyRanges(
    FIXTURE,
    [
      { path: e1Name, offset: 0, limit: 35 },
      { path: "missing-" + "m".repeat(490) + ".txt", offset: 0, limit: 1 }
    ],
    READ_LIMITS.minMaxBytes
  );
  check(
    "M1 E1: final response with pending stays within max_bytes",
    toolResultBytes(
      e1Reply.result,
      e1Reply.contentText,
      isOutcomeFailure(e1Reply.result.outcome)
    ) <= READ_LIMITS.minMaxBytes,
    String(toolResultBytes(
      e1Reply.result,
      e1Reply.contentText,
      isOutcomeFailure(e1Reply.result.outcome)
    ))
  );
  checkEqual("M1 E1: the unreturned request is pending", e1Reply.result.pendingIndexes, [1]);

  await writeFixture("m1-e2-large-line.txt", "x".repeat(12000));
  const e2Reply = await readManyRanges(
    FIXTURE,
    [
      { path: "m1-missing.txt", offset: 0, limit: 1 },
      { path: "m1-e2-large-line.txt", offset: 0, limit: 1 }
    ],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("M1 E2: failure count is not masked", e2Reply.result.failureCount, 1);
  checkEqual("M1 E2: outcome remains a failure", isOutcomeFailure(e2Reply.result.outcome), true);
  checkEqual("M1 E2: outcome code preserves the failure", e2Reply.result.outcome.code, "NOT_FOUND");
  checkEqual("M1 E2: pending is preserved", e2Reply.result.pendingIndexes, [1]);

  const refused = await readManyRanges(
    FIXTURE,
    [{
      path: "../" + path.basename(OUTSIDE) + "/secret.txt",
      offset: 0,
      limit: 1
    }],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("M1: PATH_REFUSED code is preserved", refused.result.outcome.code, "PATH_REFUSED");
  checkEqual("M1: PATH_REFUSED retry is never automatic", refused.result.outcome.retry, "never_automatic");
  checkEqual("M1: PATH_REFUSED is a failure", isOutcomeFailure(refused.result.outcome), true);

  const savedMaxReadBytes = config.maxReadBytes;
  config.maxReadBytes = Number.NaN;
  try {
    const invalidLimit = await readManyRanges(
      FIXTURE,
      [{ path: "plain.txt", offset: 0, limit: 1 }],
      READ_LIMITS.minMaxBytes
    );
    checkEqual(
      "M1: READ_LIMIT_INVALID is preserved",
      invalidLimit.result.outcome.code,
      "READ_LIMIT_INVALID"
    );
    checkEqual(
      "M1: invalid local limit is never automatic",
      invalidLimit.result.outcome.retry,
      "never_automatic"
    );
  } finally {
    config.maxReadBytes = savedMaxReadBytes;
  }

  const staleBatch = await readManyRanges(
    FIXTURE,
    [{
      path: "plain.txt",
      offset: 0,
      limit: 1,
      expected_sha256: "0".repeat(64)
    }],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("M1: STALE_REVISION is preserved", staleBatch.result.outcome.code, "STALE_REVISION");
  checkEqual("M1: STALE_REVISION is a conflict", staleBatch.result.outcome.status, "conflict");
  checkEqual("M1: STALE_REVISION is a failure", isOutcomeFailure(staleBatch.result.outcome), true);

  const mixedFailure = await readManyRanges(
    FIXTURE,
    [
      { path: "plain.txt", offset: 0, limit: 3 },
      { path: "m1-missing.txt", offset: 0, limit: 1 },
      { path: "m1-e2-large-line.txt", offset: 0, limit: 1 }
    ],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("M1: success + failure + pending keeps the failure", mixedFailure.result.failureCount, 1);
  checkEqual(
    "M1: success + failure + pending outcome is a failure",
    isOutcomeFailure(mixedFailure.result.outcome),
    true
  );
  checkEqual("M1: success + failure + pending keeps pending", mixedFailure.result.pendingIndexes, [2]);

  const multiCodeFailure = await readManyRanges(
    FIXTURE,
    [
      { path: "single-line.txt", offset: 0, limit: 1 },
      { path: "m1-missing.txt", offset: 0, limit: 1 }
    ],
    READ_LIMITS.minMaxBytes
  );
  checkEqual("M1: mixed failures remain failures", multiCodeFailure.result.failureCount, 2);
  checkEqual("M1: mixed failures use READ_FAILED", multiCodeFailure.result.outcome.code, "READ_FAILED");
  checkEqual(
    "M1: mixed failures use the most conservative retry",
    multiCodeFailure.result.outcome.retry,
    "after_refresh"
  );

  // ---------------------------------------------------------------- multi-edit patches
  checkEqual(
    "edits: every edit is applied to the same original text",
    applyEditsToText("a b", [
      { old_text: "a", new_text: "b" },
      { old_text: "b", new_text: "c" }
    ]),
    "b c"
  );
  checkEqual(
    "edits: input order does not matter",
    applyEditsToText("one two three", [
      { old_text: "three", new_text: "3" },
      { old_text: "one", new_text: "1" }
    ]),
    "1 two 3"
  );
  expectPatchEditError(
    "edits: overlapping replacements rejected",
    () => applyEditsToText("abc", [
      { old_text: "ab", new_text: "x" },
      { old_text: "bc", new_text: "y" }
    ]),
    "OVERLAPPING_EDITS",
    /overlap/i
  );
  expectPatchEditError(
    "edits: ambiguous occurrence rejected",
    () => applyEditsToText("x x", [{ old_text: "x", new_text: "y" }]),
    "AMBIGUOUS_EDIT",
    /ambiguous/i
  );
  expectPatchEditError(
    "edits: overlapping occurrence is also ambiguous",
    () => applyEditsToText("aaa", [{ old_text: "aa", new_text: "b" }]),
    "AMBIGUOUS_EDIT",
    /ambiguous/i
  );
  expectPatchEditError(
    "edits: empty old_text rejected",
    () => applyEditsToText("abc", [{ old_text: "", new_text: "x" }]),
    "EMPTY_OLD_TEXT",
    /empty/i
  );
  expectPatchEditError(
    "edits: missing old_text rejected",
    () => applyEditsToText("abc", [{ old_text: "z", new_text: "x" }]),
    "MISSING_EDIT",
    /not found/i
  );
  expectPatchEditError(
    "edits: empty edit list rejected",
    () => applyEditsToText("abc", []),
    "INVALID_EDIT",
    /1 to/i
  );
  expectPatchEditError(
    "edits: more than 100 edits rejected",
    () => applyEditsToText("a", Array.from(
      { length: PATCH_LIMITS.maxEditsPerFile + 1 },
      () => ({ old_text: "a", new_text: "b" })
    )),
    "INVALID_EDIT",
    /1 to/i
  );

  const diffSummary = summarizeEdits(
    "alpha\nbeta\n",
    "alpha\nBETA\n",
    [{ old_text: "beta", new_text: "BETA" }]
  );
  check("diff summary: edit count", diffSummary.edits === 1);
  check("diff summary: byte counts", diffSummary.bytesBefore === 11 && diffSummary.bytesAfter === 11);
  check("diff summary: line counts", diffSummary.linesBefore === 2 && diffSummary.linesAfter === 2);
  check(
    "diff summary: bounded preview shows old and new text",
    diffSummary.preview.includes("- beta") &&
      diffSummary.preview.includes("+ BETA") &&
      diffSummary.preview.length <= 1024
  );

  const zeroHash = "0".repeat(64);
  const legacyPatchArg = {
    path: "p.txt",
    expected_sha256: zeroHash,
    old_text: "a",
    new_text: "b"
  };
  const v2PatchArg = {
    path: "p.txt",
    expected_sha256: zeroHash,
    edits: [{ old_text: "a", new_text: "b" }]
  };
  check("patch schema: legacy shape accepted", applyPatchManyInputSchema.safeParse({
    patches: [legacyPatchArg]
  }).success);
  check("patch schema: V2 shape accepted", applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [v2PatchArg]
  }).success);
  check("patch schema: V2 dry_run accepted", applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    dry_run: true,
    patches: [v2PatchArg]
  }).success);
  check("patch schema: V2 max_bytes accepted", applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    max_bytes: READ_LIMITS.minMaxBytes,
    patches: [v2PatchArg]
  }).success);
  check("patch schema: legacy rejects max_bytes", !applyPatchManyInputSchema.safeParse({
    max_bytes: READ_LIMITS.minMaxBytes,
    patches: [legacyPatchArg]
  }).success);
  check("patch schema: V2 requires edits", !applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [legacyPatchArg]
  }).success);
  check("patch schema: V2 rejects old_text/new_text", !applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [{
      path: "p.txt",
      expected_sha256: zeroHash,
      old_text: "a",
      new_text: "b",
      edits: [{ old_text: "a", new_text: "b" }]
    }]
  }).success);
  check("patch schema: legacy rejects edits", !applyPatchManyInputSchema.safeParse({
    patches: [{ ...legacyPatchArg, edits: [{ old_text: "a", new_text: "b" }] }]
  }).success);
  check("patch schema: dry_run requires V2", !applyPatchManyInputSchema.safeParse({
    dry_run: true,
    patches: [legacyPatchArg]
  }).success);
  check("patch schema: more than 20 files rejected", !applyPatchManyInputSchema.safeParse({
    patches: Array.from({ length: PATCH_LIMITS.maxFiles + 1 }, () => legacyPatchArg)
  }).success);
  check("patch schema: more than 100 edits rejected", !applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [{
      path: "p.txt",
      expected_sha256: zeroHash,
      edits: Array.from(
        { length: PATCH_LIMITS.maxEditsPerFile + 1 },
        () => ({ old_text: "a", new_text: "b" })
      )
    }]
  }).success);
  check("patch schema: 100 edits accepted", applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [{
      path: "p.txt",
      expected_sha256: zeroHash,
      edits: Array.from(
        { length: PATCH_LIMITS.maxEditsPerFile },
        () => ({ old_text: "a", new_text: "b" })
      )
    }]
  }).success);
  check("patch schema: 1024-character V2 path accepted", applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [{ ...v2PatchArg, path: "a".repeat(PATCH_LIMITS.maxPathChars) }]
  }).success);
  check("patch schema: 1025-character V2 path rejected", !applyPatchManyInputSchema.safeParse({
    contract_version: 2,
    patches: [{ ...v2PatchArg, path: "a".repeat(PATCH_LIMITS.maxPathChars + 1) }]
  }).success);

  const multiText = 'const count = 1;\nconst label = "old";\nreturn count;\n';
  const multiEdits = [
    { old_text: "return count;", new_text: "return count + 1;" },
    { old_text: "const count = 1;", new_text: "const count = 2;" },
    { old_text: '"old"', new_text: '"new"' }
  ];
  const multiExpectedText = 'const count = 2;\nconst label = "new";\nreturn count + 1;\n';
  await writeFixture("multi.txt", multiText);
  const multiHash = sha256(Buffer.from(multiText, "utf8"));
  const multiExpectedHash = sha256(Buffer.from(multiExpectedText, "utf8"));

  const dryRun = await patchTextFilesBatchV2(
    [{ path: "multi.txt", expectedSha256: multiHash, edits: multiEdits }],
    FIXTURE,
    { dryRun: true }
  );
  checkEqual("dry_run: status", dryRun.status, "dry_run");
  checkEqual("dry_run: effect is none", dryRun.outcome.effectState, "none");
  checkEqual("dry_run: flag", dryRun.dry_run, true);
  checkEqual("dry_run: one file result", dryRun.files.length, 1);
  checkEqual("dry_run: file preview ok", dryRun.files[0]?.ok, true);
  checkEqual("dry_run: expected new hash", dryRun.files[0]?.sha256, multiExpectedHash);
  checkEqual("dry_run: original hash retained", dryRun.files[0]?.original_sha256, multiHash);
  checkEqual("dry_run: expected bytes", dryRun.files[0]?.bytes, Buffer.byteLength(multiExpectedText, "utf8"));
  checkEqual("dry_run: not applied", dryRun.files[0]?.applied, false);
  checkEqual("dry_run: diff edit count", dryRun.files[0]?.diff?.edits, 3);
  check(
    "dry_run: diff preview describes edits",
    dryRun.files[0]?.diff?.preview.includes("- const count = 1;") === true &&
      dryRun.files[0]?.diff?.preview.includes("+ const count = 2;") === true
  );
  checkEqual(
    "dry_run: file is untouched",
    await fs.readFile(path.join(FIXTURE, "multi.txt"), "utf8"),
    multiText
  );
  check("dry_run: output schema valid", applyPatchManyOutputSchema.safeParse(dryRun).success);

  const committed = await patchTextFilesBatchV2(
    [{ path: "multi.txt", expectedSha256: multiHash, edits: multiEdits }],
    FIXTURE
  );
  checkEqual("commit: status", committed.status, "committed");
  checkEqual("commit: effect applied", committed.outcome.effectState, "applied");
  checkEqual("commit: file hash", committed.files[0]?.sha256, multiExpectedHash);
  checkEqual("commit: applied", committed.files[0]?.applied, true);
  checkEqual(
    "commit: all edits applied to the expected content",
    await fs.readFile(path.join(FIXTURE, "multi.txt"), "utf8"),
    multiExpectedText
  );
  check("commit: output schema valid", applyPatchManyOutputSchema.safeParse(committed).success);

  await writeFixture("ambiguous.txt", "x x\n");
  const ambiguousHash = sha256(Buffer.from("x x\n", "utf8"));
  const ambiguous = await patchTextFilesBatchV2(
    [{ path: "ambiguous.txt", expectedSha256: ambiguousHash, edits: [{ old_text: "x", new_text: "y" }] }],
    FIXTURE
  );
  checkEqual("preflight: ambiguous status", ambiguous.status, "rejected");
  checkEqual("preflight: ambiguous code", ambiguous.outcome.code, "AMBIGUOUS_EDIT");
  checkEqual("preflight: ambiguous effect none", ambiguous.outcome.effectState, "none");
  checkEqual(
    "preflight: ambiguous file untouched",
    await fs.readFile(path.join(FIXTURE, "ambiguous.txt"), "utf8"),
    "x x\n"
  );

  await writeFixture("overlap.txt", "abc\n");
  const overlapHash = sha256(Buffer.from("abc\n", "utf8"));
  const overlapping = await patchTextFilesBatchV2(
    [{
      path: "overlap.txt",
      expectedSha256: overlapHash,
      edits: [
        { old_text: "ab", new_text: "x" },
        { old_text: "bc", new_text: "y" }
      ]
    }],
    FIXTURE
  );
  checkEqual("preflight: overlap status", overlapping.status, "rejected");
  checkEqual("preflight: overlap code", overlapping.outcome.code, "OVERLAPPING_EDITS");
  checkEqual(
    "preflight: overlap file untouched",
    await fs.readFile(path.join(FIXTURE, "overlap.txt"), "utf8"),
    "abc\n"
  );

  await writeFixture("zero-a.txt", "alpha\n");
  await writeFixture("zero-b.txt", "beta\n");
  const zeroAHash = sha256(Buffer.from("alpha\n", "utf8"));
  const zeroBHash = sha256(Buffer.from("beta\n", "utf8"));
  const zeroWrite = await patchTextFilesBatchV2(
    [
      { path: "zero-a.txt", expectedSha256: zeroAHash, edits: [{ old_text: "alpha", new_text: "ALPHA" }] },
      { path: "zero-b.txt", expectedSha256: zeroHash, edits: [{ old_text: "beta", new_text: "BETA" }] }
    ],
    FIXTURE
  );
  checkEqual("preflight: stale second target status", zeroWrite.status, "rejected");
  checkEqual("preflight: stale second target outcome", zeroWrite.outcome.status, "conflict");
  checkEqual("preflight: stale second target code", zeroWrite.outcome.code, "STALE_REVISION");
  checkEqual("preflight: stale second target effect none", zeroWrite.outcome.effectState, "none");
  checkEqual(
    "preflight: first target has zero writes",
    await fs.readFile(path.join(FIXTURE, "zero-a.txt"), "utf8"),
    "alpha\n"
  );
  checkEqual(
    "preflight: second target unchanged",
    await fs.readFile(path.join(FIXTURE, "zero-b.txt"), "utf8"),
    "beta\n"
  );
  checkEqual("preflight: stale result reports target", zeroWrite.files[0]?.path, "zero-b.txt");
  check("preflight: stale output schema valid", applyPatchManyOutputSchema.safeParse(zeroWrite).success);

  await writeFixture("duplicate.txt", "alpha\nbeta\n");
  const duplicateHash = sha256(Buffer.from("alpha\nbeta\n", "utf8"));
  const duplicate = await patchTextFilesBatchV2(
    [
      { path: "duplicate.txt", expectedSha256: duplicateHash, edits: [{ old_text: "alpha", new_text: "ALPHA" }] },
      { path: "duplicate.txt", expectedSha256: duplicateHash, edits: [{ old_text: "beta", new_text: "BETA" }] }
    ],
    FIXTURE
  );
  checkEqual("preflight: duplicate target status", duplicate.status, "rejected");
  checkEqual("preflight: duplicate target code", duplicate.outcome.code, "DUPLICATE_TARGET");
  checkEqual(
    "preflight: duplicate target zero writes",
    await fs.readFile(path.join(FIXTURE, "duplicate.txt"), "utf8"),
    "alpha\nbeta\n"
  );

  if (process.platform === "win32") {
    await writeFixture("case-alias.txt", "alpha\n");
    const caseHash = sha256(Buffer.from("alpha\n", "utf8"));
    const caseAlias = await patchTextFilesBatchV2(
      [
        { path: "case-alias.txt", expectedSha256: caseHash, edits: [{ old_text: "alpha", new_text: "A" }] },
        { path: "CASE-ALIAS.TXT", expectedSha256: caseHash, edits: [{ old_text: "alpha", new_text: "B" }] }
      ],
      FIXTURE
    );
    checkEqual("preflight: case-alias duplicate status", caseAlias.status, "rejected");
    checkEqual("preflight: case-alias duplicate code", caseAlias.outcome.code, "DUPLICATE_TARGET");
    checkEqual(
      "preflight: case-alias zero writes",
      await fs.readFile(path.join(FIXTURE, "case-alias.txt"), "utf8"),
      "alpha\n"
    );
  }

  const largeCandidateText = "start " + "a".repeat(600 * 1024) + "\n";
  await writeFixture("large-candidate-a.txt", largeCandidateText);
  await writeFixture("large-candidate-b.txt", largeCandidateText);
  const largeCandidateHash = sha256(Buffer.from(largeCandidateText, "utf8"));
  const largeCandidate = await patchTextFilesBatchV2(
    [
      {
        path: "large-candidate-a.txt",
        expectedSha256: largeCandidateHash,
        edits: [{ old_text: "start", new_text: "START" }]
      },
      {
        path: "large-candidate-b.txt",
        expectedSha256: largeCandidateHash,
        edits: [{ old_text: "start", new_text: "START" }]
      }
    ],
    FIXTURE
  );
  checkEqual("preflight: 1 MiB candidate limit status", largeCandidate.status, "rejected");
  checkEqual("preflight: 1 MiB candidate limit code", largeCandidate.outcome.code, "TOO_LARGE");
  checkEqual(
    "preflight: 1 MiB candidate limit zero writes on first file",
    await fs.readFile(path.join(FIXTURE, "large-candidate-a.txt"), "utf8"),
    largeCandidateText
  );
  checkEqual(
    "preflight: 1 MiB candidate limit zero writes on second file",
    await fs.readFile(path.join(FIXTURE, "large-candidate-b.txt"), "utf8"),
    largeCandidateText
  );

  await writeFixture("legacy-patch.txt", "alpha\n");
  const legacyHash = sha256(Buffer.from("alpha\n", "utf8"));
  const legacyBatch = await patchTextFilesBatch(
    [{
      path: "legacy-patch.txt",
      expectedSha256: legacyHash,
      oldText: "alpha",
      newText: "ALPHA"
    }],
    FIXTURE
  );
  checkEqual("legacy batch: success fields", legacyBatch[0]?.sha256, sha256(Buffer.from("ALPHA\n", "utf8")));
  checkEqual(
    "legacy batch: old_text/new_text still patch",
    await fs.readFile(path.join(FIXTURE, "legacy-patch.txt"), "utf8"),
    "ALPHA\n"
  );
  await writeFixture("legacy-ambiguous.txt", "x x\n");
  await expectRejects(
    "legacy batch: ambiguous error remains actionable",
    () => patchTextFilesBatch(
      [{
        path: "legacy-ambiguous.txt",
        expectedSha256: sha256(Buffer.from("x x\n", "utf8")),
        oldText: "x",
        newText: "y"
      }],
      FIXTURE
    ),
    /ambiguous/i
  );

  // ---------------------------------------------------------------- shared write locks
  let dedupedLockRan = false;
  await withWriteLocks(["dedupe-key", "dedupe-key"], async () => {
    dedupedLockRan = true;
  });
  check("locks: duplicate keys do not self-deadlock", dedupedLockRan);

  const lockOrder: string[] = [];
  await withTimeout(
    Promise.all([
      withWriteLocks(["lock-a", "lock-b"], async () => {
        lockOrder.push("a-start");
        await delay(20);
        lockOrder.push("a-end");
      }),
      withWriteLocks(["lock-b", "lock-a"], async () => {
        lockOrder.push("b-start");
        await delay(20);
        lockOrder.push("b-end");
      })
    ]),
    2000,
    "write lock deadlock"
  );
  check(
    "locks: opposite multi-key acquisitions serialize",
    lockOrder.join(",") === "a-start,a-end,b-start,b-end" ||
      lockOrder.join(",") === "b-start,b-end,a-start,a-end",
    lockOrder.join(",")
  );

  await writeFixture("concurrent-patch.txt", "value=0\n");
  const concurrentHash = sha256(Buffer.from("value=0\n", "utf8"));
  const concurrent = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      patchTextFile(
        "concurrent-patch.txt",
        concurrentHash,
        "value=0",
        `value=${index + 1}`,
        FIXTURE
      )
    )
  );
  const concurrentSuccesses = concurrent.filter((result) => result.status === "fulfilled").length;
  const concurrentFailures = concurrent.filter((result) => result.status === "rejected");
  check(
    "locks: one reviewed patch wins, seven stale writers wait",
    concurrentSuccesses === 1 && concurrentFailures.length === 7,
    `success=${concurrentSuccesses} failure=${concurrentFailures.length}`
  );
  check(
    "locks: stale writers report a version conflict",
    concurrentFailures.every((result) =>
      result.status === "rejected" &&
      String(result.reason).includes("file changed since review")
    )
  );
  check(
    "locks: final content is one complete patch",
    /^value=[1-8]\n$/.test(await fs.readFile(path.join(FIXTURE, "concurrent-patch.txt"), "utf8"))
  );

  await writeTextFile("shared-lock.txt", "0", FIXTURE);
  const sharedLockHash = sha256(Buffer.from("0", "utf8"));
  const [sharedPatch, sharedWrite] = await Promise.allSettled([
    patchTextFile("shared-lock.txt", sharedLockHash, "0", "P", FIXTURE),
    writeTextFile("shared-lock.txt", "W", FIXTURE)
  ]);
  check("locks: blind write and patch share the same path lock", sharedWrite.status === "fulfilled");
  check(
    "locks: shared write lock leaves a coherent final file",
    await fs.readFile(path.join(FIXTURE, "shared-lock.txt"), "utf8") === "W",
    String(sharedPatch.status)
  );

  await writeFixture("batch-lock.txt", "value=0\n");
  const batchLockHash = sha256(Buffer.from("value=0\n", "utf8"));
  const [batchOne, batchTwo] = await Promise.all([
    patchTextFilesBatchV2(
      [{ path: "batch-lock.txt", expectedSha256: batchLockHash, edits: [{ old_text: "value=0", new_text: "value=1" }] }],
      FIXTURE
    ),
    patchTextFilesBatchV2(
      [{ path: "batch-lock.txt", expectedSha256: batchLockHash, edits: [{ old_text: "value=0", new_text: "value=2" }] }],
      FIXTURE
    )
  ]);
  const committedBatches = [batchOne, batchTwo].filter((result) => result.status === "committed");
  const rejectedBatches = [batchOne, batchTwo].filter((result) => result.status === "rejected");
  check(
    "locks: concurrent V2 batches commit at most once",
    committedBatches.length === 1 && rejectedBatches.length === 1,
    JSON.stringify([batchOne.status, batchTwo.status])
  );
  check(
    "locks: losing batch reports no effect",
    rejectedBatches[0]?.outcome.effectState === "none" &&
      rejectedBatches[0]?.outcome.code === "STALE_REVISION"
  );
  check(
    "locks: batch final content is one complete winner",
    /^value=[12]\n$/.test(await fs.readFile(path.join(FIXTURE, "batch-lock.txt"), "utf8"))
  );

  await writeFixture("write-batch-lock.txt", "0");
  const writeBatchHash = sha256(Buffer.from("0", "utf8"));
  const writeBatchResults = await Promise.all([
    writeTextFilesBatch(
      [{ path: "write-batch-lock.txt", content: "A", expectedSha256: writeBatchHash }],
      FIXTURE
    ).then(() => true).catch(() => false),
    writeTextFilesBatch(
      [{ path: "write-batch-lock.txt", content: "B", expectedSha256: writeBatchHash }],
      FIXTURE
    ).then(() => true).catch(() => false)
  ]);
  check(
    "locks: concurrent fs_write_many batches commit at most once",
    writeBatchResults.filter(Boolean).length === 1,
    JSON.stringify(writeBatchResults)
  );
  check(
    "locks: fs_write_many final content is one complete winner",
    ["A", "B"].includes(await fs.readFile(path.join(FIXTURE, "write-batch-lock.txt"), "utf8"))
  );

  await writeFixture("legacy-batch-lock.txt", "0");
  const legacyBatchHash = sha256(Buffer.from("0", "utf8"));
  const legacyBatchResults = await Promise.all([
    patchTextFilesBatch(
      [{ path: "legacy-batch-lock.txt", expectedSha256: legacyBatchHash, oldText: "0", newText: "1" }],
      FIXTURE
    ).then(() => true).catch(() => false),
    patchTextFilesBatch(
      [{ path: "legacy-batch-lock.txt", expectedSha256: legacyBatchHash, oldText: "0", newText: "2" }],
      FIXTURE
    ).then(() => true).catch(() => false)
  ]);
  check(
    "locks: concurrent legacy apply_patch_many batches commit at most once",
    legacyBatchResults.filter(Boolean).length === 1,
    JSON.stringify(legacyBatchResults)
  );
  check(
    "locks: legacy apply_patch_many final content is one complete winner",
    ["1", "2"].includes(await fs.readFile(path.join(FIXTURE, "legacy-batch-lock.txt"), "utf8"))
  );

  // ---------------------------------------------------------------- rollback outcomes
  const rollbackEntries = (aHash: string, bHash: string) => [
    { path: "roll-a.txt", expectedSha256: aHash, edits: [{ old_text: "A0", new_text: "A1" }] },
    { path: "roll-b.txt", expectedSha256: bHash, edits: [{ old_text: "B0", new_text: "B1" }] }
  ];
  const resetRollback = async (): Promise<{ aHash: string; bHash: string }> => {
    await writeFixture("roll-a.txt", "A0\n");
    await writeFixture("roll-b.txt", "B0\n");
    return {
      aHash: sha256(Buffer.from("A0\n", "utf8")),
      bHash: sha256(Buffer.from("B0\n", "utf8"))
    };
  };

  let rollbackHashes = await resetRollback();
  const rolledBack = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: (targetPath) => {
          if (targetPath === "roll-a.txt") throw new Error("injected publish failure");
        }
      }
    }
  );
  checkEqual("rollback: publish failure status", rolledBack.status, "rolled_back");
  checkEqual("rollback: publish failure effect", rolledBack.outcome.effectState, "rolled_back");
  checkEqual("rollback: publish failure retry", rolledBack.outcome.retry, "safe");
  check("rollback: restored file reports code", rolledBack.files[0]?.errorCode === "ROLLED_BACK");
  check("rollback: untouched file reports aborted", rolledBack.files[1]?.errorCode === "BATCH_ABORTED");
  checkEqual(
    "rollback: first file restored",
    await fs.readFile(path.join(FIXTURE, "roll-a.txt"), "utf8"),
    "A0\n"
  );
  checkEqual(
    "rollback: second file never written",
    await fs.readFile(path.join(FIXTURE, "roll-b.txt"), "utf8"),
    "B0\n"
  );
  check("rollback: rolled_back output schema valid", applyPatchManyOutputSchema.safeParse(rolledBack).success);

  rollbackHashes = await resetRollback();
  const externalRewrite = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: (targetPath) => {
          if (targetPath === "roll-a.txt") throw new Error("injected publish failure");
        },
        beforeRollback: async (targetPath) => {
          if (targetPath === "roll-a.txt") {
            await fs.writeFile(path.join(FIXTURE, "roll-a.txt"), "EXTERNAL\n", "utf8");
          }
        }
      }
    }
  );
  checkEqual("rollback: external rewrite status", externalRewrite.status, "unknown");
  checkEqual("rollback: external rewrite effect", externalRewrite.outcome.effectState, "unknown");
  checkEqual("rollback: external rewrite retry", externalRewrite.outcome.retry, "never_automatic");
  checkEqual("rollback: external rewrite code", externalRewrite.outcome.code, "ROLLBACK_UNCONFIRMED");
  checkEqual(
    "rollback: external rewrite is preserved",
    await fs.readFile(path.join(FIXTURE, "roll-a.txt"), "utf8"),
    "EXTERNAL\n"
  );
  checkEqual(
    "rollback: external rewrite does not touch the other file",
    await fs.readFile(path.join(FIXTURE, "roll-b.txt"), "utf8"),
    "B0\n"
  );
  check("rollback: external rewrite reports unknown file", externalRewrite.files[0]?.errorCode === "ROLLBACK_UNCONFIRMED");
  check("rollback: unknown output schema valid", applyPatchManyOutputSchema.safeParse(externalRewrite).success);

  rollbackHashes = await resetRollback();
  const rollbackFailed = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: (targetPath) => {
          if (targetPath === "roll-a.txt") throw new Error("injected publish failure");
        },
        beforeRollback: (targetPath) => {
          if (targetPath === "roll-a.txt") throw new Error("injected rollback failure");
        }
      }
    }
  );
  checkEqual("rollback: injected rollback failure status", rollbackFailed.status, "unknown");
  checkEqual("rollback: injected rollback failure effect", rollbackFailed.outcome.effectState, "unknown");
  checkEqual("rollback: injected rollback failure retry", rollbackFailed.outcome.retry, "never_automatic");
  checkEqual(
    "rollback: failed rollback preserves the written content",
    await fs.readFile(path.join(FIXTURE, "roll-a.txt"), "utf8"),
    "A1\n"
  );
  check("rollback: failed rollback reports unknown file", rollbackFailed.files[0]?.errorCode === "ROLLBACK_UNCONFIRMED");

  // ---------------------------------------------------------------- F1 post-execution effect envelopes
  const patchBytes = (result: Awaited<ReturnType<typeof patchTextFilesBatchV2>>): number =>
    toolResultBytes(
      result,
      renderPatchBatchContent(result),
      isOutcomeFailure(result.outcome)
    );
  const f1LongA = "f1-" + "中".repeat(100) + "-a.txt";
  const f1LongB = "f1-" + "中".repeat(100) + "-b.txt";
  const f1Entries = (aHash: string, bHash: string) => [
    { path: f1LongA, expectedSha256: aHash, edits: [{ old_text: "A0", new_text: "A1" }] },
    { path: f1LongB, expectedSha256: bHash, edits: [{ old_text: "B0", new_text: "B1" }] }
  ];
  const resetF1Long = async (): Promise<{ aHash: string; bHash: string }> => {
    await writeFixture(f1LongA, "A0\n");
    await writeFixture(f1LongB, "B0\n");
    return {
      aHash: sha256(Buffer.from("A0\n", "utf8")),
      bHash: sha256(Buffer.from("B0\n", "utf8"))
    };
  };

  let f1Hashes = await resetF1Long();
  const f1Rejected = await patchTextFilesBatchV2(
    f1Entries(f1Hashes.aHash, f1Hashes.bHash),
    FIXTURE,
    { maxBytes: 4096 }
  );
  checkEqual("F1 4096: preflight rejects before mutation", f1Rejected.status, "rejected");
  checkEqual(
    "F1 4096: rejection code",
    f1Rejected.outcome.code,
    "RESULT_BUDGET_TOO_SMALL"
  );
  checkEqual("F1 4096: rejection effect", f1Rejected.outcome.effectState, "none");
  check("F1 4096: response fits", patchBytes(f1Rejected) <= 4096, String(patchBytes(f1Rejected)));
  checkEqual("F1 4096: first file unchanged", await fs.readFile(path.join(FIXTURE, f1LongA), "utf8"), "A0\n");
  checkEqual("F1 4096: second file unchanged", await fs.readFile(path.join(FIXTURE, f1LongB), "utf8"), "B0\n");

  f1Hashes = await resetF1Long();
  const f1RolledBack = await patchTextFilesBatchV2(
    f1Entries(f1Hashes.aHash, f1Hashes.bHash),
    FIXTURE,
    {
      maxBytes: 7168,
      hooks: {
        afterWrite: async (targetPath) => {
          if (targetPath === f1LongA) {
            await fs.writeFile(path.join(FIXTURE, f1LongB), "B-EXTERNAL\n", "utf8");
          }
        }
      }
    }
  );
  checkEqual("F1 7168: rolled_back status", f1RolledBack.status, "rolled_back");
  checkEqual("F1 7168: rolled_back effect", f1RolledBack.outcome.effectState, "rolled_back");
  check(
    "F1 7168: effect envelope fits",
    patchBytes(f1RolledBack) <= 7168,
    String(patchBytes(f1RolledBack))
  );
  checkEqual(
    "F1 7168: first file restored",
    await fs.readFile(path.join(FIXTURE, f1LongA), "utf8"),
    "A0\n"
  );
  checkEqual(
    "F1 7168: external second file preserved",
    await fs.readFile(path.join(FIXTURE, f1LongB), "utf8"),
    "B-EXTERNAL\n"
  );
  checkEqual("F1 7168: restored file status", f1RolledBack.files[0]?.errorCode, "ROLLED_BACK");
  checkEqual("F1 7168: stale file status", f1RolledBack.files[1]?.errorCode, "STALE_REVISION");

  f1Hashes = await resetF1Long();
  const f1Unknown = await patchTextFilesBatchV2(
    f1Entries(f1Hashes.aHash, f1Hashes.bHash),
    FIXTURE,
    {
      maxBytes: 8192,
      hooks: {
        afterWrite: async (targetPath) => {
          if (targetPath !== f1LongA) return;
          await fs.writeFile(path.join(FIXTURE, f1LongA), "F1 REPLACEMENT\n", "utf8");
          throw new Error("injected publish failure");
        }
      }
    }
  );
  checkEqual("F1 8192: unknown status", f1Unknown.status, "unknown");
  checkEqual("F1 8192: unknown effect", f1Unknown.outcome.effectState, "unknown");
  checkEqual("F1 8192: unknown retry", f1Unknown.outcome.retry, "never_automatic");
  check(
    "F1 8192: unknown envelope fits",
    patchBytes(f1Unknown) <= 8192,
    String(patchBytes(f1Unknown))
  );
  checkEqual(
    "F1 8192: replacement preserved",
    await fs.readFile(path.join(FIXTURE, f1LongA), "utf8"),
    "F1 REPLACEMENT\n"
  );

  await writeFixture(f1LongA, "A0\n");
  const f1Committed = await patchTextFilesBatchV2(
    [{
      path: f1LongA,
      expectedSha256: sha256(Buffer.from("A0\n", "utf8")),
      edits: [{ old_text: "A0", new_text: "A1" }]
    }],
    FIXTURE,
    { maxBytes: 4096 }
  );
  checkEqual("F1 committed: status", f1Committed.status, "committed");
  check(
    "F1 committed: envelope fits",
    patchBytes(f1Committed) <= 4096,
    String(patchBytes(f1Committed))
  );

  await writeFixture("f1-emoji-a.txt", "A0\n");
  await writeFixture("f1-emoji-b.txt", "B0\n");
  const f1Escaped = await patchTextFilesBatchV2(
    [{
      path: "f1-emoji-a.txt",
      expectedSha256: sha256(Buffer.from("A0\n", "utf8")),
      edits: [{ old_text: "A0", new_text: "A1" }]
    }],
    FIXTURE,
    {
      maxBytes: 6144,
      hooks: {
        afterWrite: () => {
          throw new Error(
            "注入失败😀\"\\\u0001" + "错".repeat(300)
          );
        }
      }
    }
  );
  checkEqual("F1 escaped: rolled_back status", f1Escaped.status, "rolled_back");
  check(
    "F1 escaped: final JSON bytes fit at the boundary",
    patchBytes(f1Escaped) <= 6144,
    String(patchBytes(f1Escaped))
  );
  checkEqual(
    "F1 escaped: first file restored",
    await fs.readFile(path.join(FIXTURE, "f1-emoji-a.txt"), "utf8"),
    "A0\n"
  );

  // ---------------------------------------------------------------- F2 rollback path identity
  const rollA = path.join(FIXTURE, "roll-a.txt");
  const rollAMoved = path.join(FIXTURE, "roll-a-moved.txt");

  rollbackHashes = await resetRollback();
  await fs.rm(rollAMoved, { force: true });
  const replacedPath = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: async (targetPath) => {
          if (targetPath !== "roll-a.txt") return;
          await fs.rename(rollA, rollAMoved);
          await fs.writeFile(rollA, "EXTERNAL REPLACEMENT\n", "utf8");
          throw new Error("injected publish failure");
        }
      }
    }
  );
  checkEqual("F2 rename+replace: status", replacedPath.status, "unknown");
  checkEqual("F2 rename+replace: effect", replacedPath.outcome.effectState, "unknown");
  checkEqual("F2 rename+replace: retry", replacedPath.outcome.retry, "never_automatic");
  checkEqual("F2 rename+replace: code", replacedPath.outcome.code, "ROLLBACK_UNCONFIRMED");
  checkEqual(
    "F2 rename+replace: replacement path is preserved",
    await fs.readFile(rollA, "utf8"),
    "EXTERNAL REPLACEMENT\n"
  );
  checkEqual(
    "F2 rename+replace: moved inode is not restored through the old handle",
    await fs.readFile(rollAMoved, "utf8"),
    "A1\n"
  );
  checkEqual(
    "F2 rename+replace: reports unknown file",
    replacedPath.files[0]?.errorCode,
    "ROLLBACK_UNCONFIRMED"
  );
  check(
    "F2 rename+replace: output schema valid",
    applyPatchManyOutputSchema.safeParse(replacedPath).success
  );

  rollbackHashes = await resetRollback();
  await fs.rm(rollAMoved, { force: true });
  const missingPath = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: async (targetPath) => {
          if (targetPath !== "roll-a.txt") return;
          await fs.rename(rollA, rollAMoved);
          throw new Error("injected publish failure");
        }
      }
    }
  );
  checkEqual("F2 rename to missing: status", missingPath.status, "unknown");
  checkEqual("F2 rename to missing: effect", missingPath.outcome.effectState, "unknown");
  let rollAMissing = false;
  try {
    await fs.stat(rollA);
  } catch {
    rollAMissing = true;
  }
  check("F2 rename to missing: original path stays missing", rollAMissing);
  checkEqual(
    "F2 rename to missing: moved inode is preserved",
    await fs.readFile(rollAMoved, "utf8"),
    "A1\n"
  );
  checkEqual(
    "F2 rename to missing: reports unknown file",
    missingPath.files[0]?.errorCode,
    "ROLLBACK_UNCONFIRMED"
  );

  rollbackHashes = await resetRollback();
  await fs.rm(rollAMoved, { force: true });
  const sameContentReplacement = await patchTextFilesBatchV2(
    rollbackEntries(rollbackHashes.aHash, rollbackHashes.bHash),
    FIXTURE,
    {
      hooks: {
        afterWrite: async (targetPath) => {
          if (targetPath !== "roll-a.txt") return;
          await fs.rename(rollA, rollAMoved);
          await fs.writeFile(rollA, "A1\n", "utf8");
          throw new Error("injected publish failure");
        }
      }
    }
  );
  checkEqual("F2 same-content replacement: status", sameContentReplacement.status, "unknown");
  checkEqual(
    "F2 same-content replacement: effect",
    sameContentReplacement.outcome.effectState,
    "unknown"
  );
  checkEqual(
    "F2 same-content replacement: replacement is preserved",
    await fs.readFile(rollA, "utf8"),
    "A1\n"
  );
  checkEqual(
    "F2 same-content replacement: moved inode is not rewritten",
    await fs.readFile(rollAMoved, "utf8"),
    "A1\n"
  );

  await fs.rm(path.join(FIXTURE, "roll-new.txt"), { force: true });
  await fs.rm(path.join(FIXTURE, "roll-new-moved.txt"), { force: true });
  await writeFixture("roll-b.txt", "B0\n");
  let newFileRollbackError = "";
  setPatchCommitHooksForTests({
    afterWrite: async (targetPath) => {
      if (targetPath !== "roll-new.txt") return;
      await fs.rename(
        path.join(FIXTURE, "roll-new.txt"),
        path.join(FIXTURE, "roll-new-moved.txt")
      );
      await fs.writeFile(path.join(FIXTURE, "roll-new.txt"), "NEW1\n", "utf8");
      throw new Error("injected publish failure");
    }
  });
  try {
    await writeTextFilesBatch(
      [
        { path: "roll-new.txt", content: "NEW1\n" },
        {
          path: "roll-b.txt",
          content: "B1\n",
          expectedSha256: sha256(Buffer.from("B0\n", "utf8"))
        }
      ],
      FIXTURE
    );
  } catch (error) {
    newFileRollbackError = error instanceof Error ? error.message : String(error);
  } finally {
    setPatchCommitHooksForTests(undefined);
  }
  check(
    "F2 new-file cleanup: reports incomplete rollback",
    newFileRollbackError.includes("rollback was incomplete"),
    newFileRollbackError
  );
  checkEqual(
    "F2 new-file cleanup: same-content replacement is preserved",
    await fs.readFile(path.join(FIXTURE, "roll-new.txt"), "utf8"),
    "NEW1\n"
  );
  checkEqual(
    "F2 new-file cleanup: moved new file is preserved",
    await fs.readFile(path.join(FIXTURE, "roll-new-moved.txt"), "utf8"),
    "NEW1\n"
  );
  checkEqual(
    "F2 new-file cleanup: unrelated target is untouched",
    await fs.readFile(path.join(FIXTURE, "roll-b.txt"), "utf8"),
    "B0\n"
  );

  // ---------------------------------------------------------------- F6 created-side-effect on identity failure
  type F6MutableFs = { open: (...args: any[]) => Promise<any> };
  const f6Fs = fs as unknown as F6MutableFs;
  const f6Path = (name: string): string => path.resolve(FIXTURE, name);
  const f6Eio = (): Error =>
    Object.assign(new Error("EIO: injected stat failure"), { code: "EIO" });

  const f6Single = "f6-single.txt";
  const f6SingleTarget = f6Path(f6Single);
  await fs.rm(f6SingleTarget, { force: true });
  let f6SingleStats = 0;
  let f6SingleClosed = false;
  const f6SingleOpen = f6Fs.open;
  f6Fs.open = async (file, flags, ...args) => {
    const handle = await f6SingleOpen.call(fs, file, flags, ...args);
    if (path.resolve(String(file)) === f6SingleTarget && String(flags) === "wx+") {
      const close = handle.close.bind(handle);
      handle.stat = async () => {
        f6SingleStats += 1;
        throw f6Eio();
      };
      handle.close = async (...closeArgs: any[]) => {
        f6SingleClosed = true;
        return close(...closeArgs);
      };
    }
    return handle;
  };
  let f6SingleMessage = "";
  try {
    await writeTextFilesBatch([{ path: f6Single, content: "f6 payload" }], FIXTURE);
  } catch (error) {
    f6SingleMessage = error instanceof Error ? error.message : String(error);
  } finally {
    f6Fs.open = f6SingleOpen;
  }
  check(
    "F6 single stat failure: reports possible creation side effect",
    f6SingleMessage.includes("created") &&
      f6SingleMessage.includes("identity could not be confirmed") &&
      f6SingleMessage.includes("Inspect") &&
      !f6SingleMessage.includes("before any change was applied"),
    f6SingleMessage
  );
  checkEqual("F6 single stat failure: one identity query", f6SingleStats, 1);
  check("F6 single stat failure: handle is closed", f6SingleClosed);
  check(
    "F6 single stat failure: created empty file is preserved",
    (await fs.stat(f6SingleTarget)).size === 0
  );

  const f6Persistent = "f6-persistent.txt";
  const f6PersistentTarget = f6Path(f6Persistent);
  await fs.rm(f6PersistentTarget, { force: true });
  let f6PersistentStats = 0;
  let f6PersistentClosed = false;
  const f6PersistentOpen = f6Fs.open;
  f6Fs.open = async (file, flags, ...args) => {
    const handle = await f6PersistentOpen.call(fs, file, flags, ...args);
    if (path.resolve(String(file)) === f6PersistentTarget && String(flags) === "wx+") {
      const close = handle.close.bind(handle);
      handle.stat = async () => {
        f6PersistentStats += 1;
        throw f6Eio();
      };
      handle.close = async (...closeArgs: any[]) => {
        f6PersistentClosed = true;
        return close(...closeArgs);
      };
    }
    return handle;
  };
  let f6PersistentMessage = "";
  try {
    await writeTextFilesBatch([{ path: f6Persistent, content: "persistent" }], FIXTURE);
  } catch (error) {
    f6PersistentMessage = error instanceof Error ? error.message : String(error);
  } finally {
    f6Fs.open = f6PersistentOpen;
  }
  check(
    "F6 persistent stat failure: diagnosed as unknown creation",
    f6PersistentMessage.includes("identity could not be confirmed") &&
      !f6PersistentMessage.includes("before any change was applied"),
    f6PersistentMessage
  );
  checkEqual("F6 persistent stat failure: one identity query", f6PersistentStats, 1);
  check("F6 persistent stat failure: handle is closed", f6PersistentClosed);
  check(
    "F6 persistent stat failure: file is preserved",
    (await fs.stat(f6PersistentTarget)).size === 0
  );

  const f6Replaced = "f6-replaced.txt";
  const f6ReplacedMoved = "f6-replaced-moved.txt";
  const f6ReplacedTarget = f6Path(f6Replaced);
  await fs.rm(f6ReplacedTarget, { force: true });
  await fs.rm(f6Path(f6ReplacedMoved), { force: true });
  const f6ReplacedOpen = f6Fs.open;
  f6Fs.open = async (file, flags, ...args) => {
    const handle = await f6ReplacedOpen.call(fs, file, flags, ...args);
    if (path.resolve(String(file)) === f6ReplacedTarget && String(flags) === "wx+") {
      handle.stat = async () => {
        await fs.rename(f6ReplacedTarget, f6Path(f6ReplacedMoved));
        await fs.writeFile(f6ReplacedTarget, "EXTERNAL REPLACEMENT\n", "utf8");
        throw f6Eio();
      };
    }
    return handle;
  };
  let f6ReplacedMessage = "";
  try {
    await writeTextFilesBatch([{ path: f6Replaced, content: "f6 payload" }], FIXTURE);
  } catch (error) {
    f6ReplacedMessage = error instanceof Error ? error.message : String(error);
  } finally {
    f6Fs.open = f6ReplacedOpen;
  }
  check(
    "F6 replaced during identity failure: diagnosed as unknown",
    f6ReplacedMessage.includes("identity could not be confirmed"),
    f6ReplacedMessage
  );
  checkEqual(
    "F6 replaced during identity failure: replacement is preserved",
    await fs.readFile(f6ReplacedTarget, "utf8"),
    "EXTERNAL REPLACEMENT\n"
  );
  checkEqual(
    "F6 replaced during identity failure: moved inode is preserved",
    (await fs.stat(f6Path(f6ReplacedMoved))).size,
    0
  );

  const f6Existing = "f6-existing.txt";
  const f6ExistingTarget = f6Path(f6Existing);
  await writeFixture(f6Existing, "ORIGINAL\n");
  let f6ExistingStats = 0;
  let f6ExistingClosed = false;
  const f6ExistingOpen = f6Fs.open;
  f6Fs.open = async (file, flags, ...args) => {
    const handle = await f6ExistingOpen.call(fs, file, flags, ...args);
    if (path.resolve(String(file)) === f6ExistingTarget && String(flags) === "r+") {
      const close = handle.close.bind(handle);
      handle.stat = async () => {
        f6ExistingStats += 1;
        throw f6Eio();
      };
      handle.close = async (...closeArgs: any[]) => {
        f6ExistingClosed = true;
        return close(...closeArgs);
      };
    }
    return handle;
  };
  let f6ExistingMessage = "";
  try {
    await writeTextFilesBatch([{
      path: f6Existing,
      content: "REPLACED\n",
      expectedSha256: sha256(Buffer.from("ORIGINAL\n", "utf8"))
    }], FIXTURE);
  } catch (error) {
    f6ExistingMessage = error instanceof Error ? error.message : String(error);
  } finally {
    f6Fs.open = f6ExistingOpen;
  }
  check(
    "F6 existing stat failure: reports no content written",
    f6ExistingMessage.includes("no content was written") &&
      f6ExistingMessage.includes("before any change was applied"),
    f6ExistingMessage
  );
  checkEqual("F6 existing stat failure: one identity query", f6ExistingStats, 1);
  check("F6 existing stat failure: handle is closed", f6ExistingClosed);
  checkEqual(
    "F6 existing stat failure: original bytes are unchanged",
    await fs.readFile(f6ExistingTarget, "utf8"),
    "ORIGINAL\n"
  );

  const f6MultiA = "f6-multi-a.txt";
  const f6MultiB = "f6-multi-b.txt";
  await fs.rm(f6Path(f6MultiA), { force: true });
  await fs.rm(f6Path(f6MultiB), { force: true });
  const f6MultiOpen = f6Fs.open;
  const f6MultiClosed = new Set<string>();
  f6Fs.open = async (file, flags, ...args) => {
    const handle = await f6MultiOpen.call(fs, file, flags, ...args);
    const name = path.basename(String(file));
    if (String(flags) === "wx+" && (name === f6MultiA || name === f6MultiB)) {
      const close = handle.close.bind(handle);
      handle.close = async (...closeArgs: any[]) => {
        f6MultiClosed.add(name);
        return close(...closeArgs);
      };
      if (name === f6MultiB) {
        handle.stat = async () => {
          throw f6Eio();
        };
      }
    }
    return handle;
  };
  let f6MultiMessage = "";
  try {
    await writeTextFilesBatch([
      { path: f6MultiA, content: "a" },
      { path: f6MultiB, content: "b" }
    ], FIXTURE);
  } catch (error) {
    f6MultiMessage = error instanceof Error ? error.message : String(error);
  } finally {
    f6Fs.open = f6MultiOpen;
  }
  check(
    "F6 multi-target: identifies the unconfirmed creation",
    f6MultiMessage.includes(f6MultiB) &&
      f6MultiMessage.includes("rollback was incomplete"),
    f6MultiMessage
  );
  check("F6 multi-target: both handles are closed", f6MultiClosed.size === 2);
  let f6MultiAMissing = false;
  try {
    await fs.stat(f6Path(f6MultiA));
  } catch {
    f6MultiAMissing = true;
  }
  check("F6 multi-target: confirmed empty file is cleaned up", f6MultiAMissing);
  check(
    "F6 multi-target: unconfirmed creation is preserved",
    (await fs.stat(f6Path(f6MultiB))).size === 0
  );

  // ---------------------------------------------------------------- M2 bounded I/O / complete writes
  type MutableFs = { open: (...args: any[]) => Promise<any> };
  const mutableFs = fs as unknown as MutableFs;

  const m2Expected = "value = 123;\n";
  const m2ExpectedHash = sha256(Buffer.from(m2Expected, "utf8"));
  const m2Entries = () => [{
    path: "m2-target.txt",
    expectedSha256: sha256(Buffer.from("value = 0;\n", "utf8")),
    edits: [{ old_text: "0", new_text: "123" }]
  }];

  await writeFixture("m2-target.txt", "value = 0;\n");
  {
    const originalOpen = mutableFs.open;
    const target = path.resolve(FIXTURE, "m2-target.txt");
    mutableFs.open = async (file, flags, ...args) => {
      const handle = await originalOpen.call(fs, file, flags, ...args);
      if (path.resolve(String(file)) === target && flags === "r+") {
        const write = handle.write.bind(handle);
        handle.write = (buffer: Buffer, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(3, length), position);
      }
      return handle;
    };
    try {
      const result = await patchTextFilesBatchV2(m2Entries(), FIXTURE);
      checkEqual("M2: short writes still commit", result.status, "committed");
      checkEqual("M2: short write result hash", result.files[0]?.sha256, m2ExpectedHash);
      checkEqual(
        "M2: short write file content",
        await fs.readFile(path.join(FIXTURE, "m2-target.txt"), "utf8"),
        m2Expected
      );
    } finally {
      mutableFs.open = originalOpen;
    }
  }

  await writeFixture("m2-target.txt", "value = 0;\n");
  {
    const originalOpen = mutableFs.open;
    const target = path.resolve(FIXTURE, "m2-target.txt");
    mutableFs.open = async (file, flags, ...args) => {
      const handle = await originalOpen.call(fs, file, flags, ...args);
      if (path.resolve(String(file)) === target && flags === "r+") {
        handle.write = async (buffer: Buffer) => ({ bytesWritten: 0, buffer });
      }
      return handle;
    };
    try {
      const result = await patchTextFilesBatchV2(m2Entries(), FIXTURE);
      check("M2: zero progress is not committed", result.status !== "committed");
      checkEqual(
        "M2: zero progress preserves the original bytes",
        await fs.readFile(path.join(FIXTURE, "m2-target.txt"), "utf8"),
        "value = 0;\n"
      );
    } finally {
      mutableFs.open = originalOpen;
    }
  }

  await writeFixture("m2-target.txt", "value = 0;\n");
  {
    const originalOpen = mutableFs.open;
    const target = path.resolve(FIXTURE, "m2-target.txt");
    let writes = 0;
    mutableFs.open = async (file, flags, ...args) => {
      const handle = await originalOpen.call(fs, file, flags, ...args);
      if (path.resolve(String(file)) === target && flags === "r+") {
        const write = handle.write.bind(handle);
        handle.write = async (buffer: Buffer, offset: number, length: number, position: number) => {
          writes += 1;
          if (writes === 1) return write(buffer, offset, Math.min(2, length), position);
          throw new Error("synthetic interrupted write");
        };
      }
      return handle;
    };
    try {
      const result = await patchTextFilesBatchV2([{
        path: "m2-target.txt",
        expectedSha256: sha256(Buffer.from("value = 0;\n", "utf8")),
        edits: [{ old_text: "value", new_text: "VALUE" }]
      }], FIXTURE);
      checkEqual("M2: interrupted write status", result.status, "unknown");
      checkEqual("M2: interrupted write effect", result.outcome.effectState, "unknown");
      checkEqual("M2: interrupted write retry", result.outcome.retry, "never_automatic");
      check(
        "M2: interrupted partial file is preserved",
        (await fs.readFile(path.join(FIXTURE, "m2-target.txt"), "utf8")).startsWith("VA")
      );
    } finally {
      mutableFs.open = originalOpen;
    }
  }

  await writeFixture("m2-target.txt", "value = 0;\n");
  {
    const originalOpen = mutableFs.open;
    const target = path.resolve(FIXTURE, "m2-target.txt");
    let syncCalls = 0;
    mutableFs.open = async (file, flags, ...args) => {
      const handle = await originalOpen.call(fs, file, flags, ...args);
      if (path.resolve(String(file)) === target && flags === "r+") {
        const sync = handle.sync.bind(handle);
        const write = handle.write.bind(handle);
        handle.write = (buffer: Buffer, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(3, length), position);
        handle.sync = async () => {
          syncCalls += 1;
          if (syncCalls === 1) throw new Error("synthetic sync failure");
          return sync();
        };
      }
      return handle;
    };
    try {
      const result = await patchTextFilesBatchV2(m2Entries(), FIXTURE);
      checkEqual("M2: sync failure rolls back", result.status, "rolled_back");
      checkEqual("M2: sync failure effect", result.outcome.effectState, "rolled_back");
      checkEqual(
        "M2: sync failure restores original bytes",
        await fs.readFile(path.join(FIXTURE, "m2-target.txt"), "utf8"),
        "value = 0;\n"
      );
    } finally {
      mutableFs.open = originalOpen;
    }
  }

  await writeFixture("m2-target.txt", "value = 0;\n");
  {
    const originalOpen = mutableFs.open;
    const target = path.resolve(FIXTURE, "m2-target.txt");
    let wrote = false;
    let appended = false;
    mutableFs.open = async (file, flags, ...args) => {
      const handle = await originalOpen.call(fs, file, flags, ...args);
      if (path.resolve(String(file)) === target && flags === "r+") {
        const write = handle.write.bind(handle);
        const read = handle.read.bind(handle);
        handle.write = async (...writeArgs: any[]) => {
          const result = await write(...writeArgs);
          wrote = true;
          return result;
        };
        handle.read = async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (wrote && !appended) {
            appended = true;
            await fs.appendFile(target, "EXTERNAL APPEND\n", "utf8");
          }
          return read(buffer, offset, length, position);
        };
      }
      return handle;
    };
    try {
      const result = await patchTextFilesBatchV2(m2Entries(), FIXTURE);
      checkEqual("M2: append during final read is uncertain", result.status, "unknown");
      checkEqual("M2: append during final read effect", result.outcome.effectState, "unknown");
      check(
        "M2: append during final read is preserved",
        (await fs.readFile(path.join(FIXTURE, "m2-target.txt"), "utf8")).includes("EXTERNAL APPEND")
      );
    } finally {
      mutableFs.open = originalOpen;
    }
  }

  // ---------------------------------------------------------------- M3 canonical lock keys / dry-run lock
  const lockReal = path.join(FIXTURE, "lock-real");
  const lockAlias = path.join(FIXTURE, "lock-alias");
  await fs.mkdir(lockReal, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "mklink", "/J", lockAlias, lockReal], { stdio: "pipe" });
  } else {
    await fs.symlink(lockReal, lockAlias, "dir");
  }
  const aliasTarget = path.join(lockAlias, "new", "nested", "file.txt");
  const realTarget = path.join(lockReal, "new", "nested", "file.txt");
  const missingKeys = [
    await canonicalWriteKey(aliasTarget),
    await canonicalWriteKey(realTarget)
  ];
  checkEqual("M3: aliases share a key with missing ancestors", new Set(missingKeys).size, 1);
  await fs.mkdir(path.dirname(realTarget), { recursive: true });
  checkEqual(
    "M3: aliases keep the same key after creating ancestors",
    await canonicalWriteKey(aliasTarget),
    await canonicalWriteKey(realTarget)
  );

  const sameKey = await canonicalWriteKey(realTarget);
  let inside = 0;
  let maxInside = 0;
  const lockAction = () => withWriteLocks([sameKey], async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await new Promise((resolve) => setImmediate(resolve));
    inside -= 1;
  });
  await Promise.all([lockAction(), lockAction()]);
  checkEqual("M3: same canonical key serializes critical sections", maxInside, 1);

  try {
    await withWriteLocks([sameKey], async () => {
      throw new Error("synthetic lock action failure");
    });
  } catch {
    // expected
  }
  let reacquired = false;
  await withWriteLocks([sameKey], async () => {
    reacquired = true;
  });
  check("M3: lock is released after an action failure", reacquired);

  await writeFixture("m3-dry.txt", "value = 0;\n");
  const dryHash = sha256(Buffer.from("value = 0;\n", "utf8"));
  const dryKey = await canonicalWriteKey(path.join(FIXTURE, "m3-dry.txt"));
  let releaseLock!: () => void;
  const lockGate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let enteredLock!: () => void;
  const lockEntered = new Promise<void>((resolve) => {
    enteredLock = resolve;
  });
  const holder = withWriteLocks([dryKey], async () => {
    enteredLock();
    await lockGate;
  });
  await lockEntered;
  const originalDryOpen = mutableFs.open;
  const dryState = { opened: false };
  const dryTarget = path.resolve(FIXTURE, "m3-dry.txt");
  mutableFs.open = async (file, flags, ...args) => {
    if (path.resolve(String(file)) === dryTarget) dryState.opened = true;
    return originalDryOpen.call(fs, file, flags, ...args);
  };
  try {
    const dryPromise = patchTextFilesBatchV2(
      [{
        path: "m3-dry.txt",
        expectedSha256: dryHash,
        edits: [{ old_text: "0", new_text: "1" }]
      }],
      FIXTURE,
      { dryRun: true }
    );
    await new Promise((resolve) => setImmediate(resolve));
    check("M3: dry_run waits for the shared lock", dryState.opened === false);
    releaseLock();
    await holder;
    const dry = await dryPromise;
    check("M3: dry_run completes after the lock is released", dryState.opened === true);
    checkEqual("M3: dry_run result remains dry_run", dry.status, "dry_run");
  } finally {
    mutableFs.open = originalDryOpen;
    releaseLock();
  }

  // ---------------------------------------------------------------- search coverage
  await writeFixture("search-scope/needle-a.txt", "needle alpha\n");
  await writeFixture("search-scope/plain.txt", "nothing here\n");
  await writeFixture("search-scope/sub/needle-b.txt", "needle beta\n");
  await writeFixture("search-scope/binary.bin", Buffer.from("needle\u0000binary\n", "utf8"));
  await writeFixture("search-scope/node_modules/generated.txt", "needle generated\n");
  await writeFixture("search-scope/.env", "needle=secret\n");
  await writeFixture("search-io/unreadable.txt", "nothing to find\n");

  const fullSearch = await searchTextFilesV2(
    "needle",
    "search-scope",
    FIXTURE,
    { maxResults: 10 }
  );
  checkEqual("search v2: contract marker", fullSearch.contract_version, 2);
  checkEqual("search v2: complete coverage", fullSearch.coverage.complete, true);
  checkEqual("search v2: exhausted stop reason", fullSearch.coverage.stopReason, "exhausted");
  checkEqual("search v2: legacy truncated flag", fullSearch.truncated, false);
  checkEqual("search v2: complete outcome", fullSearch.outcome.code, "SEARCH_COMPLETE");
  checkEqual("search v2: complete is not an error", isOutcomeFailure(fullSearch.outcome), false);
  checkEqual("search v2: two files match", fullSearch.matchedFiles, 2);
  checkEqual("search v2: generated directory counted", fullSearch.coverage.skippedByReason.generated_directory, 1);
  checkEqual("search v2: protected file counted", fullSearch.coverage.skippedByReason.protected, 1);
  checkEqual("search v2: binary file counted", fullSearch.coverage.skippedByReason.binary, 1);
  checkEqual(
    "search v2: coverage scannedFiles mirrors legacy field",
    fullSearch.coverage.scannedFiles,
    fullSearch.scannedFiles
  );
  checkEqual(
    "search v2: skipped reasons sum to skippedFiles",
    Object.values(fullSearch.coverage.skippedByReason).reduce((total, count) => total + count, 0),
    fullSearch.skippedFiles
  );
  check("search v2: output schema valid", fsSearchOutputSchema.safeParse(fullSearch).success);

  const legacySearch = await searchTextFiles(
    "needle",
    "search-scope",
    FIXTURE,
    { maxResults: 10 }
  );
  check(
    "search legacy: output stays free of V2 fields",
    !("coverage" in legacySearch) &&
      !("outcome" in legacySearch) &&
      !("contract_version" in legacySearch)
  );
  checkEqual("search legacy: same match count", legacySearch.matchedFiles, 2);
  check("search legacy: output schema valid", fsSearchOutputSchema.safeParse(legacySearch).success);

  const limitedSearch = await searchTextFilesV2(
    "needle",
    "search-scope",
    FIXTURE,
    { maxResults: 1 }
  );
  checkEqual("search v2: result limit is incomplete", limitedSearch.coverage.complete, false);
  checkEqual("search v2: result limit stop reason", limitedSearch.coverage.stopReason, "result_limit");
  checkEqual("search v2: result limit legacy flag", limitedSearch.truncated, true);
  checkEqual("search v2: result limit is partial", limitedSearch.outcome.status, "partial");
  checkEqual("search v2: result limit code", limitedSearch.outcome.code, "SEARCH_TRUNCATED");
  checkEqual("search v2: result limit is not an error", isOutcomeFailure(limitedSearch.outcome), false);
  checkEqual("search v2: result limit returns one file", limitedSearch.matchedFiles, 1);
  check("search v2: limited output schema valid", fsSearchOutputSchema.safeParse(limitedSearch).success);

  const unreadableHook = {
    beforeRead: (fullPath: string) => {
      if (fullPath.endsWith("unreadable.txt")) {
        throw new Error("synthetic unreadable file");
      }
    }
  };
  const ioSearch = await searchTextFilesV2(
    "needle",
    "search-io",
    FIXTURE,
    { maxResults: 10, testHooks: unreadableHook }
  );
  checkEqual("search v2: io error has no matches", ioSearch.matchCount, 0);
  checkEqual("search v2: io error is incomplete", ioSearch.coverage.complete, false);
  checkEqual("search v2: io error stop reason", ioSearch.coverage.stopReason, "io_error");
  checkEqual("search v2: io error skip count", ioSearch.coverage.skippedByReason.read_error, 1);
  checkEqual("search v2: io error outcome", ioSearch.outcome.status, "error");
  checkEqual("search v2: io error code", ioSearch.outcome.code, "SEARCH_IO_ERROR");
  checkEqual("search v2: io error is a failure", isOutcomeFailure(ioSearch.outcome), true);
  check("search v2: io output schema valid", fsSearchOutputSchema.safeParse(ioSearch).success);

  const legacyIoSearch = await searchTextFiles(
    "needle",
    "search-io",
    FIXTURE,
    { maxResults: 10, testHooks: unreadableHook }
  );
  checkEqual("search legacy: io error does not change truncated flag", legacyIoSearch.truncated, false);
  checkEqual("search legacy: io error is counted as skipped", legacyIoSearch.skippedFiles, 1);
  check("search legacy: io output schema valid", fsSearchOutputSchema.safeParse(legacyIoSearch).success);

  await writeFixture("search-lines/multi.txt", "needle needle\r\nsecond needle\r\n");
  await writeFixture("search-lines/many.txt", "needle\n".repeat(6));
  const lineSearch = await searchTextFilesV2(
    "needle",
    "search-lines",
    FIXTURE,
    { maxResults: 10 }
  );
  const multiLine = lineSearch.results.find((entry) => entry.path.endsWith("multi.txt"));
  const manyLine = lineSearch.results.find((entry) => entry.path.endsWith("many.txt"));
  checkEqual("search lines: CRLF line numbers", multiLine?.matches.map((match) => match.line), [1, 2]);
  checkEqual("search lines: occurrence counts", multiLine?.matches.map((match) => match.occurrences), [2, 1]);
  checkEqual("search lines: per-file match count", manyLine?.matchCount, 6);
  checkEqual("search lines: bounded snippet count", manyLine?.matches.length, 5);
  checkEqual("search lines: matchesTruncated", manyLine?.matchesTruncated, true);
  checkEqual("search lines: total observed matches", lineSearch.matchCount, 9);

  // ---------------------------------------------------------------- large search files / configurable scan budget
  const largeSearchText = "needle at the top\n" + ("x".repeat(60) + "\n").repeat(50000);
  await writeFixture("search-large/one.txt", largeSearchText);
  const largeSearch = await searchTextFilesV2("needle", "search-large", FIXTURE, {
    maxResults: 5
  });
  checkEqual("search large: file above legacy 2 MiB is scanned", largeSearch.matchedFiles, 1);
  checkEqual("search large: match found", largeSearch.matchCount, 1);
  checkEqual("search large: no oversized skip", largeSearch.coverage.skippedByReason.oversized, undefined);
  checkEqual("search large: complete", largeSearch.coverage.complete, true);

  const savedSearchFileBytes = config.maxSearchFileBytes;
  config.maxSearchFileBytes = 1024;
  try {
    const skippedLarge = await searchTextFilesV2("needle", "search-large", FIXTURE, {
      maxResults: 5
    });
    checkEqual("search large: per-file limit still skips oversized", skippedLarge.coverage.skippedByReason.oversized, 1);
    checkEqual("search large: skipped file yields no match", skippedLarge.matchCount, 0);
    checkEqual("search large: skipped-only scope still completes", skippedLarge.coverage.complete, true);
    check(
      "search large: skipped-only completion explains the oversized skip",
      skippedLarge.outcome.nextAction.includes("exceeded the per-file search limit") &&
        skippedLarge.outcome.nextAction.includes("fs_read_many"),
      skippedLarge.outcome.nextAction
    );
  } finally {
    config.maxSearchFileBytes = savedSearchFileBytes;
  }

  await writeFixture(
    "search-budget/a.txt",
    ("needle " + "a".repeat(200) + "\n").repeat(3000)
  );
  await writeFixture(
    "search-budget/b.txt",
    ("needle " + "b".repeat(200) + "\n").repeat(3000)
  );
  const savedSearchBytes = config.maxSearchBytes;
  config.maxSearchBytes = 1024 * 1024;
  try {
    const budgetLimited = await searchTextFilesV2("needle", "search-budget", FIXTURE, {
      maxResults: 10
    });
    checkEqual("search budget: byte limit is reported", budgetLimited.coverage.stopReason, "byte_limit");
    checkEqual("search budget: coverage is incomplete", budgetLimited.coverage.complete, false);
    check(
      "search budget: nextAction explains the scan byte limit",
      budgetLimited.outcome.nextAction.includes("scan byte limit") &&
        budgetLimited.outcome.nextAction.includes("do not increase"),
      budgetLimited.outcome.nextAction
    );
  } finally {
    config.maxSearchBytes = savedSearchBytes;
  }

  // ---------------------------------------------------------------- F3 search truncation semantics
  const searchBytes = (result: Awaited<ReturnType<typeof searchTextFilesV2>>): number =>
    toolResultBytes(
      result,
      renderSearchContent(result),
      isOutcomeFailure(result.outcome)
    );
  const longNeedleLine = "needle" + "中".repeat(400);
  for (let index = 0; index < 60; index += 1) {
    await writeFixture(
      "search-f3/" + String(index).padStart(3, "0") + ".txt",
      (longNeedleLine + "\n").repeat(6)
    );
  }
  const f3Raw = await searchTextFilesV2("needle", "search-f3", FIXTURE, { maxResults: 100 });
  checkEqual("F3: scan coverage is complete", f3Raw.coverage.complete, true);
  checkEqual("F3: upstream per-file truncation is marked", f3Raw.results[0]?.matchesTruncated, true);
  checkEqual("F3: upstream per-file match cap", f3Raw.results[0]?.matches.length, 5);

  for (const budget of [65536, 262144]) {
    const finalized = finalizeSearchResponse(f3Raw, budget);
    check(
      `F3 budget ${budget}: response is trimmed`,
      finalized.result.responseTruncated === true,
      JSON.stringify(finalized.result.returnedMatches)
    );
    const fullFile = finalized.result.results.find((file) => file.matches.length === 5);
    check(
      `F3 budget ${budget}: existing truncation marker survives response trimming`,
      fullFile?.matchesTruncated === true,
      JSON.stringify(fullFile)
    );
    check(
      `F3 budget ${budget}: response fits`,
      searchBytes(finalized.result) <= budget,
      String(searchBytes(finalized.result))
    );
    check(
      `F3 budget ${budget}: response-only nextAction mentions max_bytes`,
      finalized.result.outcome.code === "SEARCH_TRUNCATED" &&
        finalized.result.outcome.nextAction.includes("max_bytes") &&
        !finalized.result.outcome.nextAction.includes("max_results"),
      finalized.result.outcome.nextAction
    );
    check(
      `F3 budget ${budget}: scan coverage is not falsified`,
      finalized.result.coverage.complete === true
    );
  }

  const scanOnly = finalizeSearchResponse(limitedSearch, 65536);
  checkEqual("F3 scan-only: response is not trimmed", scanOnly.result.responseTruncated, false);
  check(
    "F3 scan-only: nextAction mentions the scan limit",
    scanOnly.result.outcome.nextAction.includes("max_results"),
    scanOnly.result.outcome.nextAction
  );

  const bothTruncations = await searchTextFilesV2(
    "needle",
    "search-f3",
    FIXTURE,
    { maxResults: 2 }
  );
  checkEqual("F3 both: scan is incomplete", bothTruncations.coverage.complete, false);
  checkEqual("F3 both: scan stop reason", bothTruncations.coverage.stopReason, "result_limit");
  const bothFinalized = finalizeSearchResponse(bothTruncations, 4096);
  checkEqual("F3 both: response is trimmed", bothFinalized.result.responseTruncated, true);
  check(
    "F3 both: nextAction mentions max_bytes and max_results",
    bothFinalized.result.outcome.nextAction.includes("max_bytes") &&
      bothFinalized.result.outcome.nextAction.includes("max_results"),
    bothFinalized.result.outcome.nextAction
  );
  check(
    "F3 both: response fits",
    searchBytes(bothFinalized.result) <= 4096,
    String(searchBytes(bothFinalized.result))
  );

  for (let index = 0; index < 10; index += 1) {
    await writeFixture(
      "search-f3-io/" + String(index).padStart(3, "0") + ".txt",
      (longNeedleLine + "\n").repeat(6)
    );
  }
  const f3Io = await searchTextFilesV2("needle", "search-f3-io", FIXTURE, {
    maxResults: 100,
    testHooks: {
      beforeRead: (fullPath: string) => {
        if (fullPath.endsWith("000.txt")) throw new Error("synthetic read failure");
      }
    }
  });
  checkEqual("F3 io: failure outcome", f3Io.outcome.code, "SEARCH_IO_ERROR");
  const f3IoFinalized = finalizeSearchResponse(f3Io, 4096);
  checkEqual("F3 io: response is trimmed", f3IoFinalized.result.responseTruncated, true);
  checkEqual("F3 io: failure keeps priority", f3IoFinalized.result.outcome.code, "SEARCH_IO_ERROR");
  checkEqual("F3 io: failure remains an error", isOutcomeFailure(f3IoFinalized.result.outcome), true);
  check(
    "F3 io: response fits",
    searchBytes(f3IoFinalized.result) <= 4096,
    String(searchBytes(f3IoFinalized.result))
  );

  // ---------------------------------------------------------------- F4 bounded search error envelopes
  const asciiLongRoot = "x".repeat(5000);
  const asciiLongError = await searchTextFilesV2("needle", asciiLongRoot, FIXTURE);
  checkEqual("F4 ascii path: not started", asciiLongError.coverage.stopReason, "not_started");
  checkEqual("F4 ascii path: outcome is a failure", isOutcomeFailure(asciiLongError.outcome), true);
  checkEqual("F4 ascii path: metadata omitted", asciiLongError.metadataOmitted, true);
  checkEqual("F4 ascii path: query omitted", asciiLongError.query, undefined);
  checkEqual("F4 ascii path: root omitted", asciiLongError.root, undefined);
  const asciiLongFinalized = finalizeSearchResponse(asciiLongError, 4096);
  check(
    "F4 ascii path: bounded error envelope",
    searchBytes(asciiLongFinalized.result) <= 4096,
    String(searchBytes(asciiLongFinalized.result))
  );
  check(
    "F4 ascii path: output schema valid",
    fsSearchOutputSchema.safeParse(asciiLongFinalized.result).success
  );

  const unicodeLongRoot = "中".repeat(1500);
  const unicodeLongError = await searchTextFilesV2(
    "needle",
    unicodeLongRoot,
    FIXTURE
  );
  checkEqual("F4 unicode path: not started", unicodeLongError.coverage.stopReason, "not_started");
  checkEqual("F4 unicode path: metadata omitted", unicodeLongError.metadataOmitted, true);
  const unicodeLongFinalized = finalizeSearchResponse(unicodeLongError, 4096);
  check(
    "F4 unicode path: bounded error envelope",
    searchBytes(unicodeLongFinalized.result) <= 4096,
    String(searchBytes(unicodeLongFinalized.result))
  );

  const longestQuery = "a".repeat(499) + "\u0001";
  const combinedMetadata = await searchTextFilesV2(
    longestQuery,
    asciiLongRoot,
    FIXTURE
  );
  checkEqual("F4 combined: not started", combinedMetadata.coverage.stopReason, "not_started");
  checkEqual("F4 combined: metadata omitted", combinedMetadata.metadataOmitted, true);
  const combinedFinalized = finalizeSearchResponse(combinedMetadata, 4096);
  check(
    "F4 combined: bounded error envelope",
    searchBytes(combinedFinalized.result) <= 4096,
    String(searchBytes(combinedFinalized.result))
  );
  check(
    "F4 combined: output schema valid",
    fsSearchOutputSchema.safeParse(combinedFinalized.result).success
  );

  const longRootName = "长".repeat(100);
  for (let index = 0; index < 10; index += 1) {
    await writeFixture(
      "search-long-root/" + longRootName + "/" + String(index) + ".txt",
      (longNeedleLine + "\n").repeat(6)
    );
  }
  const successLongRoot = await searchTextFilesV2(
    "needle",
    "search-long-root/" + longRootName,
    FIXTURE,
    { maxResults: 100 }
  );
  const successLongFinalized = finalizeSearchResponse(successLongRoot, 4096);
  checkEqual("F4 success: metadata omitted when needed", successLongFinalized.result.metadataOmitted, true);
  checkEqual("F4 success: root omitted", successLongFinalized.result.root, undefined);
  checkEqual("F4 success: query omitted", successLongFinalized.result.query, undefined);
  checkEqual("F4 success: response truncated flag", successLongFinalized.result.responseTruncated, true);
  check(
    "F4 success: bounded success envelope",
    searchBytes(successLongFinalized.result) <= 4096,
    String(searchBytes(successLongFinalized.result))
  );
  check(
    "F4 success: output schema valid",
    fsSearchOutputSchema.safeParse(successLongFinalized.result).success
  );

  // ---------------------------------------------------------------- F5 target-scoped retry metrics
  const traceHashA = "a".repeat(64);
  const traceHashB = "b".repeat(64);
  const tracePatch = (
    target: string | undefined,
    expectedSha256: string | undefined,
    conflict = false,
    observedCode?: string
  ) => ({
    callId: 1,
    tool: "apply_patch_many",
    ...(target ? { target } : {}),
    ...(expectedSha256 ? { expectedSha256 } : {}),
    ...(observedCode ? { observedCode } : {}),
    ...(conflict ? { conflict: true } : {})
  });
  const traceRead = (target: string, refreshedSha256: string) => ({
    callId: 2,
    tool: "fs_read_many",
    target,
    refreshedSha256
  });
  const f5A = path.join(FIXTURE, "f5-a.txt");
  const f5B = path.join(FIXTURE, "f5-b.txt");

  const sameHashSibling = metricsFor([
    tracePatch(f5A, traceHashA, true),
    traceRead(f5B, traceHashA),
    tracePatch(f5B, traceHashA)
  ]);
  checkEqual("F5 same-hash sibling: conflicts", sameHashSibling.conflicts, 1);
  checkEqual("F5 same-hash sibling: no unsafe retry", sameHashSibling.unsafeRetries, 0);

  const blindRetry = metricsFor([
    tracePatch(f5A, traceHashA, true),
    tracePatch(f5A, traceHashA, true)
  ]);
  checkEqual("F5 blind retry: conflicts", blindRetry.conflicts, 2);
  checkEqual("F5 blind retry: unsafe counted", blindRetry.unsafeRetries, 1);

  const refreshedRetry = metricsFor([
    tracePatch(f5A, traceHashA, true),
    traceRead(f5A, traceHashB),
    tracePatch(f5A, traceHashB)
  ]);
  checkEqual("F5 refreshed retry: conflicts", refreshedRetry.conflicts, 1);
  checkEqual("F5 refreshed retry: safe", refreshedRetry.unsafeRetries, 0);

  const staleAfterRefresh = metricsFor([
    tracePatch(f5A, traceHashA, true),
    traceRead(f5A, traceHashB),
    tracePatch(f5A, traceHashA, true)
  ]);
  checkEqual("F5 stale after refresh: unsafe counted", staleAfterRefresh.unsafeRetries, 1);

  const rereadSameHash = metricsFor([
    tracePatch(f5A, traceHashA, true),
    traceRead(f5A, traceHashA),
    tracePatch(f5A, traceHashA)
  ]);
  checkEqual("F5 re-read same hash: not blind", rereadSameHash.unsafeRetries, 0);

  const unattributed = metricsFor([
    tracePatch(undefined, traceHashA, true, "STALE_REVISION"),
    traceRead(f5B, traceHashA),
    tracePatch(f5B, traceHashA)
  ]);
  checkEqual("F5 unattributed: conflict is kept", unattributed.conflicts, 1);
  checkEqual("F5 unattributed: is reported separately", unattributed.unattributedConflicts, 1);
  checkEqual("F5 unattributed: no guessed unsafe retry", unattributed.unsafeRetries, 0);

  const aliasKey = await canonicalTraceTarget(
    FIXTURE,
    "lock-alias/new/nested/file.txt"
  );
  const realKey = await canonicalTraceTarget(
    FIXTURE,
    "lock-real/new/nested/file.txt"
  );
  checkEqual("F5 alias: canonical trace targets match", aliasKey, realKey);
  const aliasRetry = metricsFor([
    tracePatch(aliasKey, traceHashA, true),
    tracePatch(realKey, traceHashA, true)
  ]);
  checkEqual("F5 alias: retry through another path is unsafe", aliasRetry.unsafeRetries, 1);

  check("search schema: legacy request accepted", fsSearchInputSchema.safeParse({
    query: "needle"
  }).success);
  check("search schema: V2 request accepted", fsSearchInputSchema.safeParse({
    contract_version: 2,
    query: "needle",
    max_results: 10
  }).success);
  check("search schema: V2 max_bytes accepted", fsSearchInputSchema.safeParse({
    contract_version: 2,
    query: "needle",
    max_bytes: READ_LIMITS.minMaxBytes
  }).success);
  check("search schema: legacy rejects max_bytes", !fsSearchInputSchema.safeParse({
    query: "needle",
    max_bytes: READ_LIMITS.minMaxBytes
  }).success);

  // ---------------------------------------------------------------- M5 structured V2 errors / redaction
  const missingRoot = await searchTextFilesV2(
    "needle",
    "m5-missing-search-root",
    FIXTURE
  );
  checkEqual("M5: missing search root is not_started", missingRoot.coverage.stopReason, "not_started");
  checkEqual("M5: missing search root complete flag", missingRoot.coverage.complete, false);
  checkEqual("M5: missing search root scannedFiles", missingRoot.scannedFiles, 0);
  checkEqual("M5: missing search root outcome", missingRoot.outcome.code, "NOT_FOUND");
  checkEqual("M5: missing search root is a failure", isOutcomeFailure(missingRoot.outcome), true);
  check(
    "M5: missing search root does not leak the fixture root",
    !JSON.stringify(missingRoot).includes(FIXTURE)
  );

  const fileRoot = await searchTextFilesV2("needle", "plain.txt", FIXTURE);
  checkEqual("M5: file search root is not_started", fileRoot.coverage.stopReason, "not_started");
  checkEqual("M5: file search root outcome", fileRoot.outcome.code, "NOT_DIRECTORY");
  checkEqual("M5: file search root is a failure", isOutcomeFailure(fileRoot.outcome), true);
  check("M5: file search root does not leak the fixture root", !JSON.stringify(fileRoot).includes(FIXTURE));

  const deniedRoot = await searchTextFilesV2(
    "needle",
    "search-scope",
    FIXTURE,
    {
      testHooks: {
        beforeRootStat: () => {
          throw Object.assign(new Error("synthetic access denial"), { code: "EACCES" });
        }
      }
    }
  );
  checkEqual("M5: access denied root is not_started", deniedRoot.coverage.stopReason, "not_started");
  checkEqual("M5: access denied root outcome", deniedRoot.outcome.code, "ACCESS_DENIED");
  checkEqual("M5: access denied root is a failure", isOutcomeFailure(deniedRoot.outcome), true);

  const readdirFailure = await searchTextFilesV2(
    "needle",
    "search-scope",
    FIXTURE,
    {
      testHooks: {
        beforeReaddir: () => {
          throw new Error("synthetic readdir failure");
        }
      }
    }
  );
  checkEqual("M5: readdir failure stop reason", readdirFailure.coverage.stopReason, "io_error");
  checkEqual("M5: readdir failure complete flag", readdirFailure.coverage.complete, false);
  checkEqual("M5: readdir failure skip count", readdirFailure.coverage.skippedByReason.directory_read_error, 1);
  checkEqual("M5: readdir failure outcome", readdirFailure.outcome.code, "SEARCH_IO_ERROR");
  checkEqual("M5: readdir failure is a failure", isOutcomeFailure(readdirFailure.outcome), true);

  const statFailure = await searchTextFilesV2(
    "needle",
    "search-scope",
    FIXTURE,
    {
      testHooks: {
        beforeStat: (filePath) => {
          if (filePath.endsWith("needle-a.txt")) {
            throw new Error("synthetic stat failure");
          }
        }
      }
    }
  );
  checkEqual("M5: stat failure stop reason", statFailure.coverage.stopReason, "io_error");
  checkEqual("M5: stat failure complete flag", statFailure.coverage.complete, false);
  checkEqual("M5: stat failure skip count", statFailure.coverage.skippedByReason.stat_error, 1);
  checkEqual("M5: stat failure outcome", statFailure.outcome.code, "SEARCH_IO_ERROR");

  await writeFixture("search-skips/plain.txt", "nothing here\n");
  await writeFixture("search-skips/big.bin", "");
  await fs.truncate(
    path.join(FIXTURE, "search-skips", "big.bin"),
    config.maxReadBytes + 1
  );
  await writeFixture("search-skips-target/needle.txt", "needle hidden\n");
  const searchSkipsLink = path.join(FIXTURE, "search-skips", "link");
  const searchSkipsTarget = path.join(FIXTURE, "search-skips-target");
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "mklink", "/J", searchSkipsLink, searchSkipsTarget], { stdio: "pipe" });
  } else {
    await fs.symlink(searchSkipsTarget, searchSkipsLink, "dir");
  }
  const skips = await searchTextFilesV2("needle", "search-skips", FIXTURE);
  checkEqual("M5: oversized file skipped", skips.coverage.skippedByReason.oversized, 1);
  checkEqual("M5: symlink skipped", skips.coverage.skippedByReason.symlink, 1);
  checkEqual("M5: skipped link target is not searched", skips.matchCount, 0);
  checkEqual("M5: skips still complete the scan", skips.coverage.complete, true);
  checkEqual("M5: skips complete outcome", skips.outcome.code, "SEARCH_COMPLETE");

  const searchLinkRoot = path.join(FIXTURE, "search-link-root");
  const searchScope = path.join(FIXTURE, "search-scope");
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "mklink", "/J", searchLinkRoot, searchScope], { stdio: "pipe" });
  } else {
    await fs.symlink(searchScope, searchLinkRoot, "dir");
  }
  const linkRoot = await searchTextFilesV2("needle", "search-link-root", FIXTURE);
  checkEqual("M5: symlink search root is not_started", linkRoot.coverage.stopReason, "not_started");
  checkEqual("M5: symlink search root outcome", linkRoot.outcome.code, "PATH_REFUSED");
  checkEqual("M5: symlink search root is a failure", isOutcomeFailure(linkRoot.outcome), true);

  let legacyMissingMessage = "";
  try {
    await searchTextFiles("needle", "m5-missing-search-root", FIXTURE);
  } catch (error) {
    legacyMissingMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "M5: legacy search root error is fixed and redacted",
    legacyMissingMessage === "Search root not found." &&
      !legacyMissingMessage.includes(FIXTURE),
    legacyMissingMessage
  );

  await writeFixture("m5-hardlink-source.txt", "value = 0;\n");
  const hardlinkTarget = path.join(FIXTURE, "m5-hardlink.txt");
  await fs.link(
    path.join(FIXTURE, "m5-hardlink-source.txt"),
    hardlinkTarget
  );
  const hardlinkHash = sha256(Buffer.from("value = 0;\n", "utf8"));
  const hardlinkResult = await patchTextFilesBatchV2(
    [{
      path: "m5-hardlink.txt",
      expectedSha256: hardlinkHash,
      edits: [{ old_text: "0", new_text: "1" }]
    }],
    FIXTURE
  );
  checkEqual("M5: V2 hardlink is structured", hardlinkResult.files[0]?.errorCode, "HARDLINK_REFUSED");
  checkEqual("M5: V2 hardlink outcome is a failure", isOutcomeFailure(hardlinkResult.outcome), true);
  check(
    "M5: V2 hardlink does not leak the fixture root",
    !JSON.stringify(hardlinkResult).includes(FIXTURE)
  );

  const outsidePatch = await patchTextFilesBatchV2(
    [{
      path: "../" + path.basename(OUTSIDE) + "/secret.txt",
      expectedSha256: hardlinkHash,
      edits: [{ old_text: "outside", new_text: "changed" }]
    }],
    FIXTURE
  );
  checkEqual("M5: V2 outside patch is structured", outsidePatch.files[0]?.errorCode, "PATH_REFUSED");
  check(
    "M5: V2 outside patch does not leak the fixture root",
    !JSON.stringify(outsidePatch).includes(FIXTURE)
  );

  const protectedPatch = await patchTextFilesBatchV2(
    [{
      path: ".env",
      expectedSha256: hardlinkHash,
      edits: [{ old_text: "SECRET", new_text: "changed" }]
    }],
    FIXTURE
  );
  checkEqual("M5: V2 protected path is structured", protectedPatch.files[0]?.errorCode, "PATH_REFUSED");
  check(
    "M5: V2 protected path does not leak the fixture root",
    !JSON.stringify(protectedPatch).includes(FIXTURE)
  );

  check("search schema: unknown contract rejected", !fsSearchInputSchema.safeParse({
    contract_version: 1,
    query: "needle"
  }).success);
  check("search schema: empty query rejected", !fsSearchInputSchema.safeParse({
    query: ""
  }).success);

  // ---------------------------------------------------------------- audit classification
  const audit = new AuditStore(40);
  const runtime = new ExecutionRuntime(audit, () => "test-workspace");

  const runOutcome = async (
    outcome: ReturnType<typeof outcomeFor>,
    isError: boolean
  ): Promise<{ record: Awaited<ReturnType<typeof audit.recent>>[number]; returned: unknown }> => {
    const result = {
      content: [{ type: "text", text: "diagnostic" }],
      structuredContent: { outcome },
      ...(isError ? { isError: true } : {})
    };
    const returned = await runtime.run("workspace_current", async () => result);
    return { record: audit.recent(1)[0]!, returned };
  };

  const truncatedRun = await runOutcome(outcomeFor("READ_TRUNCATED"), false);
  check("audit: runtime returns truncated result without throwing", Boolean(truncatedRun.returned));
  checkEqual("audit: read truncation succeeds", truncatedRun.record.state, "succeeded");
  checkEqual("audit: read truncation keeps partial status", truncatedRun.record.resultStatus, "partial");
  checkEqual("audit: read truncation keeps code", truncatedRun.record.resultCode, "READ_TRUNCATED");
  checkEqual("audit: read truncation marks truncated", truncatedRun.record.resultTruncated, true);
  checkEqual("audit: read truncation recovery is none", truncatedRun.record.recoveryHint, "none");
  checkEqual("audit: read truncation has no error category", truncatedRun.record.errorCategory, undefined);

  const partialRun = await runOutcome(outcomeFor("READ_PARTIAL"), true);
  checkEqual("audit: read partial fails", partialRun.record.state, "failed");
  checkEqual("audit: read partial code", partialRun.record.resultCode, "READ_PARTIAL");
  checkEqual("audit: read partial category", partialRun.record.errorCategory, "tool");
  checkEqual("audit: read partial recovery", partialRun.record.recoveryHint, "inspect");
  checkEqual("audit: read partial phase", partialRun.record.phase, "complete");

  const conflictRun = await runOutcome(outcomeFor("STALE_REVISION"), true);
  checkEqual("audit: conflict fails", conflictRun.record.state, "failed");
  checkEqual("audit: conflict status", conflictRun.record.resultStatus, "conflict");
  checkEqual("audit: conflict retry hint", conflictRun.record.resultRetry, "after_refresh");
  checkEqual("audit: conflict recovery", conflictRun.record.recoveryHint, "inspect");

  const unknownRun = await runOutcome(outcomeFor("ROLLBACK_UNCONFIRMED"), true);
  checkEqual("audit: unknown effect fails", unknownRun.record.state, "failed");
  checkEqual("audit: unknown effect status", unknownRun.record.resultStatus, "unknown");
  checkEqual("audit: unknown effect state", unknownRun.record.resultEffectState, "unknown");
  checkEqual("audit: unknown effect retry", unknownRun.record.resultRetry, "never_automatic");
  checkEqual("audit: unknown effect category", unknownRun.record.errorCategory, "unknown");
  checkEqual("audit: unknown effect asks for human recovery", unknownRun.record.recoveryHint, "human");

  const rejectedRun = await runOutcome(outcomeFor("PATH_REFUSED"), true);
  checkEqual("audit: rejected path fails", rejectedRun.record.state, "failed");
  checkEqual("audit: rejected path status", rejectedRun.record.resultStatus, "rejected");
  checkEqual("audit: rejected path category", rejectedRun.record.errorCategory, "policy");
  checkEqual("audit: rejected path retry", rejectedRun.record.resultRetry, "never_automatic");
  checkEqual("audit: rejected path recovery", rejectedRun.record.recoveryHint, "human");

  const errorRun = await runOutcome(outcomeFor("READ_FAILED"), true);
  checkEqual("audit: ordinary read error fails", errorRun.record.state, "failed");
  checkEqual("audit: ordinary read error status", errorRun.record.resultStatus, "error");
  checkEqual("audit: ordinary read error category", errorRun.record.errorCategory, "tool");
  checkEqual("audit: ordinary read error recovery", errorRun.record.recoveryHint, "inspect");

  const searchIoRun = await runOutcome(outcomeFor("SEARCH_IO_ERROR"), true);
  checkEqual("audit: search io error fails", searchIoRun.record.state, "failed");
  checkEqual("audit: search io error code", searchIoRun.record.resultCode, "SEARCH_IO_ERROR");
  checkEqual("audit: search io error category", searchIoRun.record.errorCategory, "tool");

  const searchTruncatedRun = await runOutcome(outcomeFor("SEARCH_TRUNCATED"), false);
  checkEqual("audit: search truncation succeeds", searchTruncatedRun.record.state, "succeeded");
  checkEqual("audit: search truncation status", searchTruncatedRun.record.resultStatus, "partial");
  checkEqual("audit: search truncation code", searchTruncatedRun.record.resultCode, "SEARCH_TRUNCATED");
  checkEqual("audit: search truncation flag", searchTruncatedRun.record.resultTruncated, true);
  checkEqual("audit: search truncation recovery", searchTruncatedRun.record.recoveryHint, "none");

  const mixedAuditResult = {
    content: [{ type: "text", text: "diagnostic" }],
    isError: true,
    structuredContent: {
      outcome: outcomeFor("NOT_FOUND"),
      pendingIndexes: [1],
      failureCount: 1,
      files: [{ path: "missing.txt", ok: false, bytes: 0, errorCode: "NOT_FOUND" }]
    }
  };
  const mixedAuditReturned = await runtime.run("workspace_current", async () => mixedAuditResult);
  checkEqual("audit: mixed failure result is returned", mixedAuditReturned, mixedAuditResult);
  const mixedAuditRecord = audit.recent(1)[0]!;
  checkEqual("audit: mixed failure + pending fails", mixedAuditRecord.state, "failed");
  checkEqual("audit: mixed failure code retained", mixedAuditRecord.resultCode, "NOT_FOUND");
  checkEqual("audit: mixed failure marks truncation", mixedAuditRecord.resultTruncated, true);

  const bareError = {
    content: [{ type: "text", text: "diagnostic" }],
    isError: true
  };
  const bareReturned = await runtime.run("workspace_current", async () => bareError);
  checkEqual("audit: bare MCP error returns its diagnostic result", bareReturned, bareError);
  const bareRecord = audit.recent(1)[0]!;
  checkEqual("audit: bare MCP error fails", bareRecord.state, "failed");
  checkEqual("audit: bare MCP error category", bareRecord.errorCategory, "tool");
  checkEqual("audit: bare MCP error recovery", bareRecord.recoveryHint, "inspect");
  checkEqual("audit: bare MCP error has no invented outcome", bareRecord.resultStatus, undefined);

  await fs.rm(path.join(FIXTURE, "m7-unknown-moved.txt"), { force: true });
  await writeFixture("m7-unknown.txt", "value = 0;\n");
  const unknownHash = sha256(Buffer.from("value = 0;\n", "utf8"));
  const handlers = new Map<string, (input: any) => Promise<any>>();
  registerFsTools(
    {
      expose(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        handlers.set(name, handler);
      },
      report() { return {}; }
    } as any,
    { currentRoot: () => FIXTURE } as any
  );
  const unknownAudit = new AuditStore(20);
  const unknownRuntime = new ExecutionRuntime(unknownAudit, () => "test-workspace");
  setPatchCommitHooksForTests({
    afterWrite: async (targetPath) => {
      if (targetPath === "m7-unknown.txt") {
        await fs.rename(
          path.join(FIXTURE, "m7-unknown.txt"),
          path.join(FIXTURE, "m7-unknown-moved.txt")
        );
        await fs.writeFile(path.join(FIXTURE, targetPath), "EXTERNAL\n", "utf8");
        throw new Error("synthetic external change");
      }
    }
  });
  try {
    const unknownResult = await unknownRuntime.run(
      "apply_patch_many",
      () => handlers.get("apply_patch_many")!({
        contract_version: 2,
        patches: [{
          path: "m7-unknown.txt",
          expected_sha256: unknownHash,
          edits: [{ old_text: "0", new_text: "1" }]
        }]
      })
    );
    const unknownStructured = (unknownResult as {
      structuredContent?: Record<string, unknown>;
    }).structuredContent!;
    checkEqual("M7: unknown write is MCP error", (unknownResult as { isError?: boolean }).isError, true);
    checkEqual("M7: unknown write status", unknownStructured.status, "unknown");
    checkEqual(
      "M7: unknown write effect",
      (unknownStructured.outcome as { effectState?: unknown }).effectState,
      "unknown"
    );
    checkEqual(
      "M7: unknown write retry",
      (unknownStructured.outcome as { retry?: unknown }).retry,
      "never_automatic"
    );
    checkEqual(
      "M7: unknown write preserves external bytes",
      await fs.readFile(path.join(FIXTURE, "m7-unknown.txt"), "utf8"),
      "EXTERNAL\n"
    );
    checkEqual(
      "M7: unknown write preserves the moved inode",
      await fs.readFile(path.join(FIXTURE, "m7-unknown-moved.txt"), "utf8"),
      "value = 1;\n"
    );
    check(
      "M7: unknown structuredContent matches schema",
      applyPatchManyOutputSchema.safeParse(unknownStructured).success,
      JSON.stringify(applyPatchManyOutputSchema.safeParse(unknownStructured).error?.issues ?? [])
    );
    const unknownEvent = unknownAudit.recent(1)[0]!;
    checkEqual("M7: unknown write audit failed", unknownEvent.state, "failed");
    checkEqual("M7: unknown write audit code", unknownEvent.resultCode, "ROLLBACK_UNCONFIRMED");
    checkEqual("M7: unknown write audit retry", unknownEvent.resultRetry, "never_automatic");
    checkEqual("M7: unknown write audit recovery", unknownEvent.recoveryHint, "human");
  } finally {
    setPatchCommitHooksForTests(undefined);
  }

  // ---------------------------------------------------------------- output schema
  check(
    "patch output schema: legacy result remains valid",
    applyPatchManyOutputSchema.safeParse({
      status: "committed",
      files: [{ path: "p.txt", bytes: 1, sha256: zeroHash, created: false }],
      totalBytes: 1,
      successCount: 1
    }).success
  );
  check(
    "patch output schema: dry-run result valid",
    applyPatchManyOutputSchema.safeParse(dryRun).success
  );
  check(
    "patch output schema: committed result valid",
    applyPatchManyOutputSchema.safeParse(committed).success
  );
  check(
    "patch output schema: preflight rejection valid",
    applyPatchManyOutputSchema.safeParse(ambiguous).success
  );
  check(
    "patch output schema: unknown rollback valid",
    applyPatchManyOutputSchema.safeParse(externalRewrite).success
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
