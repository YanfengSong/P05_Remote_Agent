import fs from "node:fs/promises";
import path from "node:path";

type Release = () => void;

const lockTails = new Map<string, Promise<void>>();

/**
 * Return a stable in-process lock key for one resolved write target.
 *
 * Existing files use their real path, so a symlink and its target share a lock.
 * Missing files use the real parent directory plus the requested basename. If
 * even the parent is missing, the resolved spelling is the best available key.
 * Windows comparisons are case-insensitive.
 */
export async function canonicalWriteKey(safePath: string): Promise<string> {
  let canonical = path.resolve(safePath);

  try {
    canonical = await fs.realpath(safePath);
  } catch {
    try {
      const parent = await fs.realpath(path.dirname(safePath));
      canonical = path.join(parent, path.basename(safePath));
    } catch {
      // Keep the resolved spelling. The actual write will report a useful error.
    }
  }

  const resolved = path.resolve(canonical);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function acquire(key: string): Promise<Release> {
  const previous = lockTails.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  lockTails.set(key, tail);

  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  };
}

/**
 * Acquire every canonical path in sorted order, deduplicating repeats, then run
 * the action. Locks are released in reverse order. Sorting is what prevents two
 * multi-path writers from deadlocking each other.
 *
 * This is an in-process mutex for P05's own writers. It is not an OS file lock
 * and does not stop another process from changing the file.
 */
export async function withWriteLocks<T>(
  canonicalPaths: readonly string[],
  action: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(canonicalPaths)].sort();
  const releases: Release[] = [];

  try {
    for (const key of keys) {
      releases.push(await acquire(key));
    }
    return await action();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
