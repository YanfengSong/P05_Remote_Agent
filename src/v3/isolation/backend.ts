import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { windowsPowerShellEnv } from "../../host/windows-powershell-env.js";

const exec = promisify(execFile);
const factsSchema = z.object({
  osVersion: z.string().max(160), edition: z.string().max(160), hypervisorPresent: z.boolean().nullable(),
  windowsSandboxExecutable: z.boolean(), appContainerApiLibrary: z.boolean(), wslExecutable: z.boolean(),
  dockerExecutable: z.boolean(), bubblewrapExecutable: z.boolean(), appContainerLauncher: z.boolean(),
  optionalFeatureQuery: z.enum(["ENABLED", "DISABLED", "UNVERIFIED", "NOT_APPLICABLE"])
}).strict();
export type IsolationHostFacts = z.infer<typeof factsSchema>;
export interface IsolationHostAdapter {
  readonly platform: NodeJS.Platform;
  /** Inventory only. Executable presence and OS features are never enforcement evidence. */
  probe(): Promise<IsolationHostFacts>;
}
export interface IsolationRequirements {
  mode: "isolated-worker";
  filesystem: "workspace-only";
  network: "none";
  readOnlyReferences: true;
  processTreeControl: true;
}
export interface IsolationBackendDescriptor {
  backendId: string;
  version: "inventory-v1";
  supportedPlatforms: string[];
  availability: "UNAVAILABLE";
  candidatePresent: boolean;
  filesystemEnforcement: "unverified";
  networkEnforcement: "unverified";
  principalIsolation: "unverified";
  processTreeControl: "unverified";
  secretDelivery: "unsupported";
  readOnlyReference: "unverified";
  reattachSupport: false;
  limitations: string[];
  requiredEvidence: string[];
  probeTime: string;
}
export interface IsolationReport {
  availability: "UNAVAILABLE";
  actualSecurityMode: null;
  platform: NodeJS.Platform;
  probeCode: "INVENTORY_ONLY" | "HOST_PROBE_FAILED";
  facts: IsolationHostFacts | null;
  backends: IsolationBackendDescriptor[];
}
export class IsolationUnavailableError extends Error {
  readonly code = "ISOLATION_BACKEND_UNAVAILABLE";
  constructor() { super("No verified isolated execution backend is installed; no task was dispatched"); this.name = "IsolationUnavailableError"; }
}

const windowsInventory = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function HasCommand([string]$name) { return [bool](Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1) }
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$feature = 'UNVERIFIED'
try { $state = (Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -ErrorAction Stop).State; if ($state -eq 'Enabled') { $feature = 'ENABLED' } elseif ($state -eq 'Disabled') { $feature = 'DISABLED' } } catch { }
[ordered]@{osVersion=$os.Version;edition=$os.Caption;hypervisorPresent=[bool]$computer.HypervisorPresent;
 windowsSandboxExecutable=(HasCommand 'WindowsSandbox.exe');appContainerApiLibrary=(Test-Path (Join-Path $env:SystemRoot 'System32\\userenv.dll'));
 wslExecutable=(HasCommand 'wsl.exe');dockerExecutable=(HasCommand 'docker.exe');bubblewrapExecutable=(HasCommand 'bwrap');
 appContainerLauncher=((HasCommand 'mxc.exe') -or (HasCommand 'runinappcontainer.exe'));optionalFeatureQuery=$feature} | ConvertTo-Json -Compress
`;

export function createSystemIsolationHostAdapter(): IsolationHostAdapter {
  return {
    platform: process.platform,
    async probe() {
      if (process.platform !== "win32") throw new Error("PLATFORM_PROBE_NOT_IMPLEMENTED");
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("SYSTEM_EXECUTABLE_UNAVAILABLE");
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const env = windowsPowerShellEnv();
      // PowerShell performs fixed read-only inventory. No optional tool is executed,
      // no WSL distribution/container is started, and no system feature is enabled.
      const { stdout } = await exec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsInventory, "utf16le").toString("base64")],
        { env, windowsHide: true, timeout: 15000, maxBuffer: 16384, encoding: "utf8" });
      return factsSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
    }
  };
}

/** This inventory/gate deliberately has no spawn or trusted-host fallback path. */
export function createIsolationBackend(adapter: IsolationHostAdapter = createSystemIsolationHostAdapter()) {
  const probe = async (): Promise<IsolationReport> => {
    let facts: IsolationHostFacts | null = null;
    try { facts = factsSchema.parse(await adapter.probe()); } catch { /* Missing evidence fails closed. */ }
    const common = { version: "inventory-v1" as const, availability: "UNAVAILABLE" as const,
      filesystemEnforcement: "unverified" as const, networkEnforcement: "unverified" as const, principalIsolation: "unverified" as const,
      processTreeControl: "unverified" as const, secretDelivery: "unsupported" as const, readOnlyReference: "unverified" as const,
      reattachSupport: false as const, probeTime: new Date().toISOString(), requiredEvidence: [
        "Pinned protected runner and immutable Workspace/identity binding",
        "Real outside-root, reference-write, runner-write, link and descendant escape negative tests",
        "Real denied network with reachable positive control; inherited credentials absent",
        "Bounded resources, owned process-tree cancellation, durable dispatch/receipt/reattach integration"
      ] };
    const backends: IsolationBackendDescriptor[] = [
      { ...common, backendId: "windows-sandbox", supportedPlatforms: ["win32"], candidatePresent: facts?.windowsSandboxExecutable ?? false,
        limitations: ["No P05 runner/receipt bridge implemented", "Windows Home is not supported by Windows Sandbox", "Feature visibility and hypervisor presence do not attest policy"] },
      { ...common, backendId: "windows-appcontainer", supportedPlatforms: ["win32"], candidatePresent: facts?.appContainerApiLibrary ?? false,
        limitations: ["API library presence does not create an AppContainer token or capability policy", "Native protected launcher, file ACL and network capability validation are not implemented"] },
      { ...common, backendId: "wsl-bubblewrap", supportedPlatforms: ["win32/linux-worker"], candidatePresent: facts?.wslExecutable ?? false,
        limitations: ["WSL availability alone is not a sandbox", "Linux-only experiment does not isolate native Windows tools", "Windows mounts/interop, runner trust and durable lifecycle require explicit adapter validation"] },
      { ...common, backendId: "docker-worker", supportedPlatforms: ["win32/linux-worker", "linux"], candidatePresent: facts?.dockerExecutable ?? false,
        limitations: ["CLI presence does not attest a running daemon or pinned image", "No protected container execution/receipt bridge implemented; never mount the Docker socket or Core state"] },
      { ...common, backendId: "linux-bubblewrap", supportedPlatforms: ["linux"], candidatePresent: facts?.bubblewrapExecutable ?? false,
        limitations: ["No native Linux HostAdapter integration has been validated", "bubblewrap requires a correctly configured policy; binary presence is insufficient"] }
    ];
    return { availability: "UNAVAILABLE", actualSecurityMode: null, platform: adapter.platform,
      probeCode: facts ? "INVENTORY_ONLY" : "HOST_PROBE_FAILED", facts, backends };
  };
  return {
    probe,
    async require(_requirements: IsolationRequirements): Promise<never> {
      // Approval or caller-provided labels cannot manufacture a missing backend.
      throw new IsolationUnavailableError();
    }
  };
}
