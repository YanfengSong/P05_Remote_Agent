/**
 * Deterministic I/O primitives regression: bounded snapshots, stable identity,
 * short writes, zero progress and interrupted writes.
 *
 * Run: node dist/test/file-io.js
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileHandle } from "node:fs/promises";
import {
  FileIoError,
  readBoundedSnapshot,
  validatePositiveFileLimit,
  writeAllAtStart
} from "../tools/file-io.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_file_io_test");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

async function expectFileIoError(
  code: string,
  action: () => Promise<unknown>
): Promise<void> {
  try {
    await action();
  } catch (error) {
    check(
      `file-io: ${code}`,
      error instanceof FileIoError && error.code === code,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return;
  }
  throw new Error(`FAIL file-io: expected ${code}`);
}

type ReadFn = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
) => Promise<{ bytesRead: number; buffer: Buffer }>;

type WriteFn = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
) => Promise<{ bytesWritten: number; buffer: Buffer }>;

type WrappedHandle = FileHandle & {
  __writeCalls?: number;
};

function wrapHandle(
  handle: FileHandle,
  hooks: {
    read?: (original: ReadFn) => ReadFn;
    write?: (original: WriteFn) => WriteFn;
  }
): WrappedHandle {
  const originalRead = (handle.read as unknown as ReadFn).bind(handle);
  const originalWrite = (handle.write as unknown as WriteFn).bind(handle);
  const wrapped = {
    stat: handle.stat.bind(handle),
    close: handle.close.bind(handle),
    read: hooks.read ? hooks.read(originalRead) : originalRead,
    write: hooks.write ? hooks.write(originalWrite) : originalWrite
  };
  return wrapped as unknown as WrappedHandle;
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(FIXTURE, { recursive: true });

try {
  const normalPath = path.join(FIXTURE, "normal.txt");
  await fs.writeFile(normalPath, "hello world", "utf8");
  const normalHandle = await fs.open(normalPath, "r");
  const normal = await readBoundedSnapshot(normalHandle, 1024);
  await normalHandle.close();
  check("snapshot: bytes", normal.bytes.toString("utf8") === "hello world");
  check("snapshot: bigint stat", normal.stat.size === 11n);
  check("snapshot: regular file", normal.stat.isFile());

  const tooLargeHandle = await fs.open(normalPath, "r");
  await expectFileIoError("TOO_LARGE", () =>
    readBoundedSnapshot(tooLargeHandle, 4)
  );
  await tooLargeHandle.close();

  const dirHandle = await fs.open(FIXTURE, "r");
  await expectFileIoError("IS_DIRECTORY", () =>
    readBoundedSnapshot(dirHandle, 1024)
  );
  await dirHandle.close();

  const shortPath = path.join(FIXTURE, "short.txt");
  const shortHandle = await fs.open(shortPath, "w+");
  const shortWrapped = wrapHandle(shortHandle, {
    write: (original) => async (buffer, offset, length, position) => {
      const result = await original(buffer, offset, Math.min(3, length), position);
      shortWrapped.__writeCalls = (shortWrapped.__writeCalls ?? 0) + 1;
      return result;
    }
  });
  await writeAllAtStart(shortWrapped, Buffer.from("short write payload", "utf8"));
  await shortHandle.close();
  check(
    "write: short writes are completed",
    (await fs.readFile(shortPath, "utf8")) === "short write payload"
  );
  check("write: more than one call", (shortWrapped.__writeCalls ?? 0) > 1);

  const zeroPath = path.join(FIXTURE, "zero.txt");
  const zeroHandle = await fs.open(zeroPath, "w+");
  const zeroWrapped = wrapHandle(zeroHandle, {
    write: () => async (buffer: Buffer) => ({ bytesWritten: 0, buffer })
  });
  await expectFileIoError("WRITE_NO_PROGRESS", () =>
    writeAllAtStart(zeroWrapped, Buffer.from("abc", "utf8"))
  );
  await zeroHandle.close();

  const interruptedPath = path.join(FIXTURE, "interrupted.txt");
  const interruptedHandle = await fs.open(interruptedPath, "w+");
  let interruptedCalls = 0;
  const interruptedWrapped = wrapHandle(interruptedHandle, {
    write: (original) => async (buffer, offset, length, position) => {
      interruptedCalls += 1;
      if (interruptedCalls === 1) {
        return original(buffer, offset, Math.min(2, length), position);
      }
      throw new Error("synthetic write interruption");
    }
  });
  await expectFileIoError("WRITE_FAILED", () =>
    writeAllAtStart(interruptedWrapped, Buffer.from("abcdef", "utf8"))
  );
  await interruptedHandle.close();
  check(
    "write: interrupted write leaves a visible partial file",
    (await fs.readFile(interruptedPath, "utf8")) === "ab"
  );

  const growthPath = path.join(FIXTURE, "growth.txt");
  await fs.writeFile(growthPath, "abcd", "utf8");
  const growthHandle = await fs.open(growthPath, "r");
  let growthRead = false;
  const growthWrapped = wrapHandle(growthHandle, {
    read: (original) => async (buffer, offset, length, position) => {
      const result = await original(buffer, offset, length, position);
      if (!growthRead) {
        growthRead = true;
        await fs.appendFile(growthPath, "EXTERNAL", "utf8");
      }
      return result;
    }
  });
  await expectFileIoError("FILE_UNSTABLE", () =>
    readBoundedSnapshot(growthWrapped, 1024)
  );
  await growthHandle.close();
  check(
    "snapshot: growth is preserved on disk",
    (await fs.readFile(growthPath, "utf8")) === "abcdEXTERNAL"
  );

  const shrinkPath = path.join(FIXTURE, "shrink.txt");
  await fs.writeFile(shrinkPath, "abcdef", "utf8");
  const shrinkHandle = await fs.open(shrinkPath, "r");
  let shrunk = false;
  const shrinkWrapped = wrapHandle(shrinkHandle, {
    read: (original) => async (buffer, offset, length, position) => {
      if (!shrunk) {
        shrunk = true;
        await fs.truncate(shrinkPath, 2);
      }
      return original(buffer, offset, length, position);
    }
  });
  await expectFileIoError("FILE_UNSTABLE", () =>
    readBoundedSnapshot(shrinkWrapped, 1024)
  );
  await shrinkHandle.close();

  const sameSizePath = path.join(FIXTURE, "same-size.txt");
  await fs.writeFile(sameSizePath, "abcdef", "utf8");
  const sameSizeHandle = await fs.open(sameSizePath, "r");
  let modified = false;
  const sameSizeWrapped = wrapHandle(sameSizeHandle, {
    read: (original) => async (buffer, offset, length, position) => {
      if (!modified) {
        modified = true;
        await fs.writeFile(sameSizePath, "ABCDEF", "utf8");
        await fs.utimes(sameSizePath, new Date(), new Date(Date.now() + 2000));
      }
      return original(buffer, offset, length, position);
    }
  });
  await expectFileIoError("FILE_UNSTABLE", () =>
    readBoundedSnapshot(sameSizeWrapped, 1024)
  );
  await sameSizeHandle.close();

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    try {
      validatePositiveFileLimit(invalid, "maxReadBytes");
      check(`limits: ${String(invalid)} rejected`, false);
    } catch (error) {
      check(
        `limits: ${String(invalid)} fails closed`,
        error instanceof FileIoError && error.code === "INVALID_LIMIT"
      );
    }
  }
  assert.equal(validatePositiveFileLimit(1024, "maxReadBytes"), 1024);

  console.log(`FILE_IO_OK (${checks} checks)`);
} finally {
  const resolved = path.resolve(FIXTURE);
  if (!resolved.startsWith(path.resolve(REPO) + path.sep)) {
    throw new Error(`Refusing to clean a fixture outside the repository: ${resolved}`);
  }
  await fs.rm(FIXTURE, { recursive: true, force: true });
}
