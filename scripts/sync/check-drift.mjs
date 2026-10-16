import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGoldenState } from "../../dist/sync/collector.js";
import { checkGoldenStateDrift } from "../../dist/sync/drift.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const input = process.argv[2] || "sync/golden-state.json";
const target = path.resolve(root, input);
const raw = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
const desired = JSON.parse(raw);
const result = checkGoldenStateDrift(desired, collectGoldenState());

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "in_sync" ? 0 : 2;
