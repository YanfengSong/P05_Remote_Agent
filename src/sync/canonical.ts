import { createHash } from "node:crypto";
import type { GoldenState } from "./types.js";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(sortValue)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortValue(record[key])])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function stateRevision(state: Omit<GoldenState, "revision" | "generatedAt">): string {
  return sha256(state);
}
