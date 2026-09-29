import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupV3 } from "../v3/setup.js";
import { readV3Config } from "../v3/config.js";
import { verifyStateProtection } from "../v3/protection.js";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";

const fixture = await createPrivateV3Fixture();
try {
  const stateDir = path.join(fixture.root, "new-installation");
  const result = await setupV3({ stateDir, workspaceRoot: fixture.workspace, slotId: "A", principal: "setup-test" });
  assert.equal((await verifyStateProtection(result.stateDir)).verified, true);
  const original = await fs.readFile(result.configFile, "utf8");
  const config = readV3Config(result.configFile);
  assert.equal(config.allowWrites, false); assert.equal(config.allowHostExecute, false);
  await assert.rejects(setupV3({ stateDir, workspaceRoot: fixture.workspace, slotId: "B", principal: "replacement" }));
  assert.equal(await fs.readFile(result.configFile, "utf8"), original);
  await assert.rejects(setupV3({ stateDir: path.join(fixture.workspace, "bad-state"), workspaceRoot: fixture.workspace, slotId: "A", principal: "setup-test" }), /STATE_WORKSPACE_OVERLAP/);
  assert.equal(await fs.stat(path.join(fixture.workspace, "bad-state")).then(() => true, () => false), false);
  console.log("V3_SETUP_OK (new private directory, readonly defaults, existing config untouched, overlap refused)");
} finally { await fixture.remove(); }
