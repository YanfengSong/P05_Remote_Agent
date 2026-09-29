import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPrivateV3Fixture } from "./v3-private-fixture.js";
import { verifyStateProtection, verifyConfigurationProtection } from "../v3/protection.js";

const fixture = await createPrivateV3Fixture();
try {
  const secret = path.join(fixture.state, "private.json");
  await fs.writeFile(secret, "{}", { mode: 0o600 });
  assert.equal((await verifyStateProtection(fixture.state)).verified, true);
  assert.equal((await verifyConfigurationProtection(secret)).verified, true);
  if (process.platform === "win32") {
    // Dedicated empty negative fixture: no credentials or real user data are written here.
    const exposed = await createPrivateV3Fixture(true);
    try { assert.equal((await verifyStateProtection(exposed.state)).verified, false, "InheritOnly exposes future credentials"); }
    finally { await exposed.remove(); }
  } else {
    await fs.chmod(secret, 0o644);
    assert.equal((await verifyStateProtection(fixture.state)).verified, false, "Private parent cannot conceal public child");
    await fs.chmod(secret, 0o600);
  }
  const link = path.join(fixture.state, "linked-workspace");
  await fs.symlink(fixture.workspace, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await verifyStateProtection(fixture.state)).verified, false);
  await fs.unlink(link);
  console.log("V3_PROTECTION_OK (actual private permissions, inherited exposure refusal, reparse refusal)");
} finally { await fixture.remove(); }
