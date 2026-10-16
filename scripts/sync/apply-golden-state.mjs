import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGoldenState } from "../../dist/sync/apply.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const input = process.argv[2] || "sync/golden-state.json";
const target = path.resolve(root, input);
if (target !== root && !target.startsWith(root + path.sep)) {
  throw new Error("Golden State input must remain inside the P05 repository.");
}

const desired = JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
const result = applyGoldenState(desired);

console.log(JSON.stringify({
  ok: true,
  action: "apply-golden-state",
  revision: desired.revision,
  sourceCommit: desired.source?.gitCommit,
  ...result
}, null, 2));
