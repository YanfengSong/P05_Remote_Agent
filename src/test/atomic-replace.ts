import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicReplaceSync } from "../state/atomic-replace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "p05-atomic-"));
const source = path.join(root, "candidate.json");
const destination = path.join(root, "state.json");
try {
  fs.writeFileSync(source, "new");
  fs.writeFileSync(destination, "old");
  const blocked = Object.assign(new Error("temporary sharing violation"), { code: "EPERM" });
  if (process.platform === "win32") {
    let attempts = 0;
    let pauses = 0;
    atomicReplaceSync(source, destination, {
      rename(from, to) {
        assert.equal(fs.readFileSync(destination, "utf8"), "old");
        if (++attempts < 3) throw blocked;
        fs.renameSync(from, to);
      },
      pause() { pauses++; }
    });
    assert.equal(attempts, 3);
    assert.equal(pauses, 2);
    assert.equal(fs.readFileSync(destination, "utf8"), "new");
    fs.writeFileSync(source, "next");
    attempts = 0;
    assert.throws(() => atomicReplaceSync(source, destination, {
      rename() { attempts++; throw blocked; },
      pause() {}
    }), error => error === blocked);
    assert.equal(attempts, 6);
    assert.equal(fs.readFileSync(destination, "utf8"), "new");
    assert.equal(fs.readFileSync(source, "utf8"), "next");
  }
  let attempts = 0;
  const permanent = Object.assign(new Error("storage failure"), { code: "EIO" });
  assert.throws(() => atomicReplaceSync(source, destination, {
    rename() { attempts++; throw permanent; },
    pause() { assert.fail("permanent I/O failures must not retry"); }
  }), error => error === permanent);
  assert.equal(attempts, 1);
  console.log("ATOMIC_REPLACE_OK (temporary lock, bounded failure, destination preserved)");
} finally {
  // mkdtemp above is the sole producer of this absolute test-owned root.
  fs.rmSync(root, { recursive: true, force: true });
}
