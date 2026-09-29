import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Status = "PASS" | "PARTIAL" | "NOT_RUN" | "N/A";
type Row = { id: string; status: Status; evidence: string; gap: string };

const file = path.resolve(process.cwd(), "docs", "roadmap", "V3_ACCEPTANCE_TRACEABILITY.md");
const text = fs.readFileSync(file, "utf8");
const rows: Row[] = [];
for (const line of text.split(/\r?\n/)) {
  const match = line.match(/^\|\s*(T\d{2})\s*\|\s*(PASS|PARTIAL|NOT_RUN|N\/A)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
  if (match) rows.push({ id: match[1], status: match[2] as Status, evidence: match[3].trim(), gap: match[4].trim() });
}
const expected = Array.from({ length: 70 }, (_, index) => "T" + String(index + 1).padStart(2, "0"));
assert.equal(rows.length, 70, "Acceptance matrix must contain exactly T01-T70");
assert.deepEqual(rows.map((row) => row.id), expected, "Acceptance IDs must be unique and ordered T01-T70");
for (const row of rows) {
  assert.ok(row.evidence.length > 0, row.id + " must name evidence or explicitly say none");
  assert.ok(row.gap.length > 0, row.id + " must state closure or remaining gap");
  if (row.status === "PASS") assert.notEqual(row.evidence, "none", row.id + " PASS requires concrete evidence");
  if (row.status === "N/A") assert.notEqual(row.gap, "none", row.id + " N/A requires an applicability rationale");
}
const counts = Object.fromEntries(["PASS", "PARTIAL", "NOT_RUN", "N/A"].map((status) => [status, rows.filter((row) => row.status === status).length]));
console.log("V3 acceptance matrix: " + JSON.stringify(counts));
