import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShellEnv } from "../host/windows-powershell-env.js";

const source: NodeJS.ProcessEnv = {
  PSModulePath: "incompatible modules",
  pSmOdUlEpAtH: "another casing",
  Path: "preserve executable search path",
  P05_TEST_SENTINEL: "preserve other configuration"
};
const before = { ...source };
const normalized = windowsPowerShellEnv(source);
assert.deepEqual(source, before, "the supplied environment must not be modified");
assert.notEqual(normalized, source);
assert.equal(Object.keys(normalized).some((key) => key.toLowerCase() === "psmodulepath"), false);
assert.equal(normalized.Path, source.Path);
assert.equal(normalized.P05_TEST_SENTINEL, source.P05_TEST_SENTINEL);

if (process.platform !== "win32") {
  console.log("WINDOWS_POWERSHELL_ENV_OK (environment contract; Windows integration skipped)");
} else {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p05-ps-env-"));
  try {
    const moduleRoot = path.join(fixtureRoot, "modules");
    const fakeModule = path.join(moduleRoot, "Microsoft.PowerShell.Utility");
    fs.mkdirSync(fakeModule, { recursive: true });
    fs.writeFileSync(path.join(fakeModule, "Microsoft.PowerShell.Utility.psm1"),
      "function Get-FileHash { throw 'P05_POISONED_MODULE_PATH' }; Export-ModuleMember -Function Get-FileHash\n");
    const target = path.join(fixtureRoot, "hash-input.txt");
    const contents = "p05-powershell-environment-regression\n";
    fs.writeFileSync(target, contents);
    const expectedHash = createHash("sha256").update(contents).digest("hex").toUpperCase();
    const polluted = { ...windowsPowerShellEnv(), PSModulePath: moduleRoot };
    const probe = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", "Get-FileHash"
    ], { env: polluted, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.ifError(probe.error);
    assert.match(probe.stderr, /P05_POISONED_MODULE_PATH/, "prove the inherited path actually poisons command discovery");

    // Exercise the product entry point in a separately polluted parent process.
    // This test never changes the test runner or operating system environment.
    const shellModule = new URL("../tools/shell.js", import.meta.url).href;
    const program = `
      import assert from "node:assert/strict";
      import { runPowerShell } from ${JSON.stringify(shellModule)};
      const original = process.env.PSModulePath;
      const result = await runPowerShell(
        ${JSON.stringify(`Get-FileHash -Algorithm SHA256 -LiteralPath '${target.replaceAll("'", "''")}' | ConvertTo-Json`)},
        ${JSON.stringify(fixtureRoot)}, ${JSON.stringify(fixtureRoot)}, 10000);
      assert.equal(result.stderr.trim(), "");
      assert.match(result.stdout, /SHA256/);
      assert.ok(result.stdout.includes(${JSON.stringify(expectedHash)}), result.stdout);
      assert.equal(process.env.PSModulePath, original);
      assert.equal(original, ${JSON.stringify(moduleRoot)});
      console.log("PRODUCT_POWERSHELL_ENV_OK");
    `;
    const result = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", program], {
      env: {
        ...polluted,
        REMOTE_AGENT_ALLOWED_ROOTS: fixtureRoot,
        REMOTE_AGENT_DEFAULT_CWD: fixtureRoot
      },
      encoding: "utf8", windowsHide: true, timeout: 20_000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PRODUCT_POWERSHELL_ENV_OK/);
    console.log("WINDOWS_POWERSHELL_ENV_OK (polluted module discovery, real SHA256, unchanged parent environment)");
  } finally {
    // mkdtemp returns this exact, newly created absolute fixture directory.
    assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureRoot).startsWith("p05-ps-env-"));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
