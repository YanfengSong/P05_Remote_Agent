import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--")) || "sync/golden-state.json";
const runtimeArg = args.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length)?.trim().toUpperCase();

if (runtimeArg === "A" || runtimeArg === "B") {
  process.env.P05_SYNC_STATE_DIR = path.join(root, ".p05", "runtime-" + runtimeArg.toLowerCase(), "state");
}

const { collectGoldenState } = await import("../../dist/sync/collector.js");
const { checkGoldenStateDrift } = await import("../../dist/sync/drift.js");

const target = path.resolve(root, input);
const desired = JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
const result = checkGoldenStateDrift(desired, collectGoldenState());

console.log(JSON.stringify({
  ...result,
  runtimeStateDir: process.env.P05_SYNC_STATE_DIR || path.join(root, ".p05")
}, null, 2));
process.exitCode = result.status === "in_sync" ? 0 : 2;
