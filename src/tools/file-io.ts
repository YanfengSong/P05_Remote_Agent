import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type FileIoErrorCode =
  | "INVALID_LIMIT"
  | "NOT_REGULAR_FILE"
  | "IS_DIRECTORY"
  | "TOO_LARGE"
  | "FILE_UNSTABLE"
  | "READ_FAILED"
  | "WRITE_INCOMPLETE"
  | "WRITE_NO_PROGRESS"
  | "WRITE_FAILED";

export class FileIoError extends Error {
  readonly code: FileIoErrorCode;

  constructor(code: FileIoErrorCode, message: string) {
    super(message);
    this.name = "FileIoError";
    this.code = code;
  }
}

export type FileSnapshot = {
  bytes: Buffer;
  stat: BigIntStats;
};

function safeLimit(limit: number, allowZero = true): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    (!allowZero && limit === 0)
  ) {
    throw new FileIoError("INVALID_LIMIT", "The file size limit is invalid.");
  }
  return limit;
}

/** Validate a configured read/write budget before any allocation or write. */
export function validatePositiveFileLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileIoError("INVALID_LIMIT", `${label} must be a positive safe integer.`);
  }
  return value;
}

function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

/**
 * Read one bounded snapshot from an already-open handle. The buffer, size and
 * metadata must all describe the same stable file revision. The caller owns
 * opening and closing the handle.
 */
export async function readBoundedSnapshot(
  handle: FileHandle,
  limit: number
): Promise<FileSnapshot> {
  const boundedLimit = safeLimit(limit);

  try {
    const before = await handle.stat({ bigint: true });
    if (before.isDirectory()) {
      throw new FileIoError("IS_DIRECTORY", "Path is a directory, not a file.");
    }
    if (!before.isFile()) {
      throw new FileIoError("NOT_REGULAR_FILE", "Path is not a regular file.");
    }
    if (before.size > BigInt(boundedLimit)) {
      throw new FileIoError("TOO_LARGE", "File exceeds the read limit.");
    }

    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new FileIoError("TOO_LARGE", "File size is outside the supported range.");
    }

    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0) {
        throw new FileIoError("FILE_UNSTABLE", "File changed while it was being read; retry.");
      }
      if (result.bytesRead > buffer.length - offset) {
        throw new FileIoError("FILE_UNSTABLE", "File changed while it was being read; retry.");
      }
      if (result.bytesRead === 0) {
        throw new FileIoError("FILE_UNSTABLE", "File changed while it was being read; retry.");
      }
      offset += result.bytesRead;
    }

    // A one-byte probe past the observed size catches growth that occurred while
    // the bounded buffer was being filled.
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, size);
    if (extra.bytesRead !== 0) {
      throw new FileIoError("FILE_UNSTABLE", "File changed while it was being read; retry.");
    }

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) {
      throw new FileIoError("FILE_UNSTABLE", "File changed while it was being read; retry.");
    }

    return { bytes: buffer, stat: before };
  } catch (error) {
    if (error instanceof FileIoError) throw error;
    throw new FileIoError("READ_FAILED", "Could not read the file.");
  }
}

/**
 * Write the complete buffer at position zero. Node may return a short write; a
 * zero or impossible count is a hard failure, never a successful commit.
 */
export async function writeAllAtStart(
  handle: FileHandle,
  bytes: Buffer
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    let result: { bytesWritten: number };
    try {
      result = await handle.write(bytes, offset, remaining, offset);
    } catch {
      throw new FileIoError("WRITE_FAILED", "Could not write the file.");
    }

    const written = result.bytesWritten;
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
      throw new FileIoError(
        written <= 0 ? "WRITE_NO_PROGRESS" : "WRITE_INCOMPLETE",
        written <= 0 ? "Write made no progress." : "Write was incomplete."
      );
    }
    offset += written;
  }
}
