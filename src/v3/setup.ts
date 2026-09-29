import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellEnv } from "../host/windows-powershell-env.js";
import { verifyStateProtection } from "./protection.js";
import { readV3Config } from "./config.js";

function within(root: string, target: string) {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(target));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Provision only a NEW empty state directory. Never change ACLs on an existing installation. */
export async function setupV3(options: { stateDir: string; workspaceRoot: string; slotId: "A" | "B"; principal: string }) {
  if (!path.isAbsolute(options.stateDir) || !path.isAbsolute(options.workspaceRoot) || !["A", "B"].includes(options.slotId) || !options.principal.trim() || options.principal.length > 128) throw new Error("INVALID_SETUP_ARGUMENTS");
  const workspaceRoot = await fs.realpath(options.workspaceRoot);
  if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
  const requested = path.resolve(options.stateDir);
  const parent = await fs.realpath(path.dirname(requested));
  const stateDir = path.join(parent, path.basename(requested));
  if (within(workspaceRoot, stateDir) || within(stateDir, workspaceRoot)) throw new Error("STATE_WORKSPACE_OVERLAP");
  if (stateDir === path.parse(stateDir).root || /^[/\\]{2}/.test(stateDir)) throw new Error("STATE_PATH_INVALID");
  // Exclusive mkdir is the authorization boundary: pre-existing paths are never modified.
  await fs.mkdir(stateDir, { recursive: false, mode: 0o700 });
  if (process.platform === "win32") {
    const script = `
$ErrorActionPreference = 'Stop'
$target = $env:P05_SETUP_NEW_STATE
if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -ne 0) { throw 'New state is not empty' }
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($current)
foreach ($sid in @($current, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $target -AclObject $acl
`;
    await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...windowsPowerShellEnv(), P05_SETUP_NEW_STATE: stateDir }, windowsHide: true, timeout: 10000, maxBuffer: 8192
    });
  }
  if (!(await verifyStateProtection(stateDir)).verified) throw new Error("NEW_STATE_PROTECTION_FAILED");
  const configFile = path.join(stateDir, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ version: 1, slotId: options.slotId, principal: options.principal,
    stateDir, workspaceId: "default", workspaceRoot, authorizationRevision: "local-policy-1", port: 0,
    optionalRuntime: true, trustedHost: false, allowWrites: false, allowHostExecute: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  readV3Config(configFile);
  return { configFile, stateDir, workspaceRoot, slotId: options.slotId, writesEnabled: false, hostExecuteEnabled: false, osSandbox: false };
}
