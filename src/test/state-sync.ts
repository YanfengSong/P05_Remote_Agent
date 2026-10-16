import fs from "node:fs/promises";
import path from "node:path";
import { collectGoldenState, goldenStateComparable } from "../sync/collector.js";
import { checkGoldenStateDrift } from "../sync/drift.js";
import { sha256 } from "../sync/canonical.js";

const fixture = path.resolve("_p05_state_sync_test");
await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(fixture, { recursive: true });

let checks = 0;
function check(label: string, condition: boolean): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}`);
}

try {
  process.env.P05_STATE_DIR = fixture;
  process.env.P05_APPROVAL_MODE_STATE_FILE = path.join(fixture, "approval-mode.json");
  process.env.P05_WORKSPACES_JSON = JSON.stringify([
    { id: "platform", root: fixture, kind: "platform-source", label: "P05 platform workspace" },
    { id: "project-a", root: fixture, kind: "git-project", label: "Project A", plugins: ["matlab"] }
  ]);
  process.env.P05_ACTIVE_WORKSPACE_ID = "project-a";
  process.env.P05_TOOL_PROFILE = "developer";
  process.env.P05_APPROVAL_MODE = "standard";
  process.env.P05_RUNTIME_SLOTS = "A,B";
  process.env.P05_RUNTIME_A_PROFILE = "p05-a";
  process.env.P05_RUNTIME_B_PROFILE = "p05-b";

  const state = collectGoldenState();
  check("schema version", state.schemaVersion === 1);
  check("revision is stable", state.revision === sha256(goldenStateComparable(state)));

  const sourceOnlyChange = JSON.parse(JSON.stringify(state));
  sourceOnlyChange.source.gitCommit = "0".repeat(40);
  check(
    "source commit is not configuration drift",
    checkGoldenStateDrift(state, sourceOnlyChange).status === "in_sync"
  );
  check("workspace root is never exported", !JSON.stringify(state).includes(fixture));
  check("workspace active id is exported", state.workspace.activeId === "project-a");
  check("plugin version is exported", state.plugins.some((entry) => entry.id === "matlab"));
  check("capability catalog hash exists", /^[a-f0-9]{64}$/.test(state.capabilities.catalogSha256));
  check("runtime slot profile is exported", state.runtime.slots.some((entry) => entry.id === "B" && entry.profileName === "p05-b"));

  const same = checkGoldenStateDrift(state, JSON.parse(JSON.stringify(state)));
  check("identical state is in sync", same.status === "in_sync" && same.changes.length === 0);

  const drifted = JSON.parse(JSON.stringify(state));
  drifted.policy.toolProfile = "readonly";
  const drift = checkGoldenStateDrift(state, drifted);
  check(
    "policy drift is detected",
    drift.status === "drift" &&
      drift.changes.some((entry) => entry.path === "policy.toolProfile")
  );

  const changedGeneratedAt = JSON.parse(JSON.stringify(state));
  changedGeneratedAt.generatedAt = "2099-01-01T00:00:00.000Z";
  const generatedAtOnly = checkGoldenStateDrift(state, changedGeneratedAt);
  check("generatedAt does not create drift", generatedAtOnly.status === "in_sync");

  console.log(`STATE_SYNC_OK (${checks} checks)`);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
