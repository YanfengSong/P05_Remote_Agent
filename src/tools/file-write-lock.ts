import fs from "node:fs/promises";
import path from "node:path";

type Release = () => void;

const lockTails = new Map<string, Promise<void>>();

/**
 * Return a stable in-process lock key for one resolved write target.
 *
 * Resolve the nearest existing ancestor with realpath, then append the missing
 * path segments in their original order. This makes an alias and its real path
 * share a key even before intermediate directories exist. Only ENOENT/ENOTDIR
 * mean "not created yet"; permission failures, link loops and every other
 * resolution error fail closed.
 */
export async function canonicalWriteKey(safePath: string): Promise<string> {
  const resolved = path.resolve(safePath);
  const missing: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      const canonical = missing.length === 0
        ? real
        : path.join(real, ...missing.reverse());
      return process.platform === "win32"
        ? path.resolve(canonical).toLowerCase()
        : path.resolve(canonical);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error("Could not resolve the write target path.");
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Could not resolve the write target path.");
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
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
