import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const command = process.platform === "win32"
  ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm run test:compiled"] }
  : { file: "npm", args: ["run", "test:compiled"] };
const result = spawnSync(command.file, command.args, {
  cwd: root,
  env: {
    ...process.env,
    REMOTE_AGENT_ALLOWED_ROOTS: root,
    REMOTE_AGENT_DEFAULT_CWD: root,
  },
  stdio: "inherit",
  windowsHide: true,
});
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, "V2 regression failed inside the V3 workspace");
console.log("V3 gate: V2 compatibility regression passed in " + path.basename(root));
