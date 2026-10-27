import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const repo = process.cwd();
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "p05-independent-review-"));
process.env.REMOTE_AGENT_ALLOWED_ROOTS = scratch;
process.env.REMOTE_AGENT_DEFAULT_CWD = scratch;
process.env.REMOTE_AGENT_MAX_READ_BYTES = String(8 * 1024 * 1024);
const load = (file) => import(pathToFileURL(path.join(repo, "src", file)).href);
const { readManyRanges } = await load("tools/read-ranges.ts");
const { toolResultBytes } = await load("tools/result-budget.ts");
const { isOutcomeFailure } = await load("tools/file-contracts.ts");
const { patchTextFilesBatchV2 } = await load("tools/files.ts");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const sizeOf = (value) => toolResultBytes(value.result, value.contentText, isOutcomeFailure(value.result.outcome));
const findings = [];
try {
  const longName = "a".repeat(146) + ".txt";
  let overflow;
  await fs.writeFile(path.join(scratch, longName), "x".repeat(100) + "\n" + "x\n".repeat(35));
  const calibration = await readManyRanges(scratch,[{path:longName,offset:0,limit:35}],4096);
  const center = 100 + Math.floor((4096 - sizeOf(calibration)) / 2);
  for (let length = Math.max(0,center - 100); length <= center + 10; length++) {
    await fs.writeFile(path.join(scratch, longName), "x".repeat(length) + "\n" + "x\n".repeat(35));
    const result = await readManyRanges(scratch, [
      {path:longName, offset:0, limit:35},
      {path:"missing-" + "m".repeat(490), offset:0, limit:1}
    ],4096);
    if (sizeOf(result) > 4096) {
      overflow = {lineWidth:length, bytes:sizeOf(result), returned:result.result.files[0]?.returnedLines,
        pending:result.result.pendingIndexes, code:result.result.outcome.code};
      break;
    }
  }
  findings.push({probe:"final-budget", reproduced:!!overflow, ...overflow});

  await fs.writeFile(path.join(scratch, "large-line.txt"), "x".repeat(12000));
  const masked = await readManyRanges(scratch, [
    {path:"missing.txt",offset:0,limit:1},
    {path:"large-line.txt",offset:0,limit:1}
  ],4096);
  findings.push({probe:"failure-masked-by-pending", failures:masked.result.failureCount,
    code:masked.result.outcome.code,isError:isOutcomeFailure(masked.result.outcome),
    pending:masked.result.pendingIndexes,bytes:sizeOf(masked)});

  const originalOpen = fs.open;
  const target = path.join(scratch,"short-write.txt");
  const before = "const count = 1;\n", after = "const count = 123456789;\n";
  await fs.writeFile(target,before);
  try {
    fs.open = async function(file, flags, ...args) {
      const handle = await originalOpen.call(fs,file,flags,...args);
      if (String(file) === target && flags === "r+") {
        const originalWrite = handle.write.bind(handle);
        handle.write = (buffer, offset, length, position) =>
          originalWrite(buffer, offset, Math.max(1,Math.floor(length / 2)), position);
      }
      return handle;
    };
    const result = await patchTextFilesBatchV2([{
      path:"short-write.txt",expectedSha256:sha(before),
      edits:[{old_text:"1",new_text:"123456789"}]
    }],scratch);
    const actual = await fs.readFile(target);
    findings.push({probe:"short-write-success",status:result.status,
      reportedBytes:result.files[0]?.bytes,actualBytes:actual.length,
      reportedHashMatches:result.files[0]?.sha256 === sha(actual)});
  } finally { fs.open = originalOpen; }

  const raceTarget = path.join(scratch,"append-race.txt");
  await fs.writeFile(raceTarget,before);
  let reads = 0;
  try {
    fs.open = async function(file,flags,...args) {
      const handle = await originalOpen.call(fs,file,flags,...args);
      if(String(file) === raceTarget && flags === "r+") {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          reads++;
          if(reads === 2) await fs.appendFile(raceTarget,"EXTERNAL APPEND\n");
          return result;
        };
      }
      return handle;
    };
    const result = await patchTextFilesBatchV2([{
      path:"append-race.txt",expectedSha256:sha(before),
      edits:[{old_text:"1",new_text:"2"}]
    }],scratch);
    findings.push({probe:"append-during-final-read",status:result.status,
      externalPreserved:(await fs.readFile(raceTarget,"utf8")).includes("EXTERNAL")});
  } finally { fs.open = originalOpen; }
  const {canonicalWriteKey} = await load("tools/file-write-lock.ts");
  await fs.mkdir(path.join(scratch,"real"));
  await fs.symlink(path.join(scratch,"real"),path.join(scratch,"alias"),process.platform === "win32" ? "junction" : "dir");
  const aliasTarget = path.join(scratch,"alias/new/nested/file.txt");
  const realTarget = path.join(scratch,"real/new/nested/file.txt");
  const missingParentKeysEqual = await canonicalWriteKey(aliasTarget) === await canonicalWriteKey(realTarget);
  await fs.mkdir(path.dirname(realTarget),{recursive:true});
  const existingParentKeysEqual = await canonicalWriteKey(aliasTarget) === await canonicalWriteKey(realTarget);
  findings.push({probe:"missing-ancestor-lock-key",missingParentKeysEqual,existingParentKeysEqual});
  console.log(JSON.stringify({reviewHead:"7d491b9",findings},null,2));
} finally {
  const actual = path.resolve(scratch);
  const parent = path.resolve(os.tmpdir());
  if(path.dirname(actual) !== parent || !path.basename(actual).startsWith("p05-independent-review-"))
    throw new Error("Refusing cleanup outside the dedicated fixture");
  await fs.rm(actual,{recursive:true,force:true});
}
