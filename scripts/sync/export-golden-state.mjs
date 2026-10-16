import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length)?.trim().toUpperCase();

if (runtimeArg === "A" || runtimeArg === "B") {
  process.env.P05_SYNC_STATE_DIR = path.join(root, ".p05", "runtime-" + runtimeArg.toLowerCase(), "state");
} else if (!process.env.P05_SYNC_STATE_DIR) {
  const a = path.join(root, ".p05", "runtime-a", "state");
  const b = path.join(root, ".p05", "runtime-b", "state");
  if (fs.existsSync(a)) process.env.P05_SYNC_STATE_DIR = a;
  else if (fs.existsSync(b)) process.env.P05_SYNC_STATE_DIR = b;
}

const { collectGoldenState } = await import("../../dist/sync/collector.js");

const output = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[1])
  || "sync/golden-state.json";
const target = path.resolve(root, output);

if (target !== root && !target.startsWith(root + path.sep)) {
  throw new Error("Golden State output must remain inside the P05 repository.");
}

const state = collectGoldenState();
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(state, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  ok: true,
  action: "export-golden-state",
  revision: state.revision,
  sourceCommit: state.source.gitCommit,
  runtimeStateDir: process.env.P05_SYNC_STATE_DIR || path.join(root, ".p05"),
  output: path.relative(root, target)
}, null, 2));
