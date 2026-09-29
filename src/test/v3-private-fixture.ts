import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellEnv } from "../host/windows-powershell-env.js";

/** Test-only fixture. Tightens ACLs solely on a freshly created, empty test state directory. */
export async function createPrivateV3Fixture(testInheritedExposure = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "p05-v3-e2e-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await fs.mkdir(workspace);
  await fs.mkdir(state, { mode: 0o700 });
  if (process.platform === "win32") {
    const target = await fs.realpath(state);
    const canonicalRoot = await fs.realpath(root);
    if (path.dirname(target) !== canonicalRoot || (await fs.readdir(target)).length !== 0) throw new Error("Invalid private fixture target");
    const script = `
$ErrorActionPreference = 'Stop'
$target = $env:P05_TEST_PRIVATE_STATE
if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -ne 0) { throw 'Fixture is not empty' }
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($current)
foreach ($sid in @($current, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
${testInheritedExposure ? "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'S-1-1-0', 'Read', 'ContainerInherit,ObjectInherit', 'InheritOnly', 'Allow')))" : ""}
Set-Acl -LiteralPath $target -AclObject $acl
`;
    await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...windowsPowerShellEnv(), P05_TEST_PRIVATE_STATE: target }, windowsHide: true, timeout: 10000, maxBuffer: 8192
    });
  }
  return {
    root, workspace, state,
    async remove() {
      const canonicalRoot = await fs.realpath(root);
      const temp = await fs.realpath(os.tmpdir());
      if (path.dirname(canonicalRoot) !== temp || !path.basename(canonicalRoot).startsWith("p05-v3-e2e-")) throw new Error("Unsafe fixture cleanup target");
      await fs.rm(canonicalRoot, { recursive: true, force: true });
    }
  };
}
