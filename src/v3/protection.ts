import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProtectionAssessment } from "./core/index.js";
import { windowsPowerShellEnv } from "../host/windows-powershell-env.js";

const exec = promisify(execFile);
const script = `
$ErrorActionPreference = 'Stop'
$target = $env:P05_ACL_PROBE_PATH
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
$safe = $true
$queue = New-Object 'System.Collections.Generic.Queue[string]'
$queue.Enqueue($target)
$count = 0
while ($queue.Count -gt 0 -and $safe) {
  $itemPath = $queue.Dequeue()
  $count++
  if ($count -gt 4096) { throw 'Protection scan limit' }
  $item = Get-Item -LiteralPath $itemPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $safe = $false; break }
  $acl = Get-Acl -LiteralPath $itemPath
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $owner) { $safe = $false; break }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    # InheritOnly access can expose newly created credentials even if the parent itself is private.
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { $safe = $false }
  }
  if ($safe -and $item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $itemPath -Force) { $queue.Enqueue($child.FullName) }
  }
}
if ($safe) { 'PRIVATE_OWNER_ACL' } else { 'SHARED_ACCESS_ACL' }
`;

/** Read-only ACL/owner probe. It never creates accounts, changes ACLs, or claims an execution sandbox. */
async function verifyPrivatePath(stateDir: string, kind: "directory" | "file"): Promise<ProtectionAssessment> {
  try {
    const stat = await fs.lstat(stateDir);
    if ((kind === "directory" ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()) return { verified: false, code: "STATE_PATH_INVALID" };
    if (process.platform !== "win32") {
      const queue = [stateDir];
      let count = 0;
      while (queue.length) {
        const candidate = queue.shift()!;
        const item = await fs.lstat(candidate);
        if (++count > 4096 || item.isSymbolicLink() || typeof process.getuid !== "function" || item.uid !== process.getuid() || (item.mode & 0o077) !== 0) {
          return { verified: false, code: "POSIX_OWNER_MODE_CHECK_FAILED" };
        }
        if (item.isDirectory()) {
          const { join } = await import("node:path");
          for (const entry of await fs.readdir(candidate)) queue.push(join(candidate, entry));
        }
      }
      return { verified: true, code: "POSIX_OWNER_MODE_CHECK" };
    }
    const { stdout } = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...windowsPowerShellEnv(), P05_ACL_PROBE_PATH: stateDir },
      timeout: 10000, maxBuffer: 8192, windowsHide: true
    });
    return { verified: stdout.trim() === "PRIVATE_OWNER_ACL", code: stdout.trim() === "PRIVATE_OWNER_ACL" ? "WINDOWS_PRIVATE_OWNER_ACL" : "WINDOWS_SHARED_OR_UNVERIFIED_ACL" };
  } catch {
    return { verified: false, code: "STATE_PROTECTION_PROBE_FAILED" };
  }
}

export const verifyStateProtection = (stateDir: string): Promise<ProtectionAssessment> => verifyPrivatePath(stateDir, "directory");
export const verifyConfigurationProtection = (filename: string): Promise<ProtectionAssessment> => verifyPrivatePath(filename, "file");
