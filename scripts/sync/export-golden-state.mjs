import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGoldenState } from "../../dist/sync/collector.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = process.argv[2] || "sync/golden-state.json";
const target = path.resolve(root, output);

if (target !== root && !target.startsWith(root + path.sep)) {
  throw new Error("Golden State output must remain inside the P05 repository.");
}

const state = collectGoldenState();
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ok: true, revision: state.revision, sourceCommit: state.source.gitCommit, output: path.relative(root, target) }, null, 2));
