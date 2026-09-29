import fs from "node:fs";

/** Preserve atomic replacement; never unlink the destination to work around a lock. */
export function atomicReplaceSync(
  source: string,
  destination: string,
  operations = {
    rename: fs.renameSync,
    pause: (milliseconds: number): void => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  }
): void {
  const delays = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt++) {
    try {
      operations.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(code ?? "") || attempt >= delays.length) {
        throw error;
      }
      operations.pause(delays[attempt]!);
    }
  }
}
