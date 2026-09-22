import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { p05StateDir } from "../state.js";
import { readOwnEnv } from "../env.js";

const execFileAsync = promisify(execFile);

const P05_ROOT = p05StateDir();
const TUNNEL_CLIENT =
  process.env.P05_OPERATOR_TUNNEL_CLIENT ??
  path.join(P05_ROOT, "tools", "tunnel-client", "tunnel-client.exe");
const TUNNEL_PROFILE_DIR =
  process.env.P05_TUNNEL_PROFILE_DIR ??
  path.join(P05_ROOT, "tunnel", "profiles");

export type RuntimeSlotId = "A" | "B";

const TUNNEL_ID_PATTERN = /^tunnel_[A-Za-z0-9]+$/;

export function configuredRuntimeSlots(): RuntimeSlotId[] {
  const raw = readOwnEnv("P05_RUNTIME_SLOTS")?.trim();
  if (raw) {
    const slots: RuntimeSlotId[] = [];
    const seen = new Set<RuntimeSlotId>();
    for (const part of raw.split(",")) {
      const slot = part.trim().toUpperCase();
      if (slot !== "A" && slot !== "B") {
        throw new Error(`Invalid runtime slot "${slot}" in P05_RUNTIME_SLOTS.`);
      }
      if (seen.has(slot)) {
        throw new Error(`Duplicate runtime slot "${slot}" in P05_RUNTIME_SLOTS.`);
      }
      seen.add(slot);
      slots.push(slot);
    }
    return slots;
  }

  const slots: RuntimeSlotId[] = [];
  if (TUNNEL_ID_PATTERN.test(readOwnEnv("P05_TUNNEL_A_ID")?.trim() ?? "")) slots.push("A");
  if (TUNNEL_ID_PATTERN.test(readOwnEnv("P05_TUNNEL_B_ID")?.trim() ?? "")) slots.push("B");
  return slots;
}

export function runtimeSlotConfigured(slot: RuntimeSlotId): boolean {
  return configuredRuntimeSlots().includes(slot);
}

function assertRuntimeSlotConfigured(slot: RuntimeSlotId): void {
  if (!runtimeSlotConfigured(slot)) {
    throw new Error(
      `Runtime ${slot} is not configured. Add ${slot} to P05_RUNTIME_SLOTS and run bootstrap.ps1 again.`
    );
  }
}

type RuntimeSlotConfig = {
  id: RuntimeSlotId;
  connector: string;
  profileName: string;
  stateDir: string;
  healthUrlFile: string;
  tunnelLog: string;
};

function slotProfileName(slot: RuntimeSlotId): string {
  return slot === "A"
    ? process.env.P05_RUNTIME_A_PROFILE?.trim() || "p05-a"
    : process.env.P05_RUNTIME_B_PROFILE?.trim() || "p05-b";
}

function operatorRoot(): string {
  const override = process.env.P05_OPERATOR_ROOT?.trim();
  return override ? path.resolve(override) : p05StateDir();
}

function makeRuntimeSlot(slot: RuntimeSlotId, connector: string): RuntimeSlotConfig {
  const root = operatorRoot();
  const lower = slot.toLowerCase();
  const profileName = slotProfileName(slot);
  return {
    id: slot,
    connector,
    profileName,
    stateDir: path.join(root, `runtime-${lower}`, "state"),
    healthUrlFile: path.join(root, "tunnel", "health", `${profileName}.url`),
    tunnelLog: path.join(root, "tunnel", "logs", `${profileName}.log`)
  };
}

function runtimeSlotConfig(slot: RuntimeSlotId): RuntimeSlotConfig {
  return slot === "A"
    ? makeRuntimeSlot("A", "@Boonray-A")
    : makeRuntimeSlot("B", "@Boonray-B");
}

const ACTIVE_WORKSPACE_BINDING_FILE = "active-workspace.txt";

export function persistRuntimeSlotWorkspace(
  slot: RuntimeSlotId,
  workspaceId: string
): void {
  assertRuntimeSlotConfigured(slot);
  const id = workspaceId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || id === "operator-session") {
    throw new Error("Only a registered Workspace can be bound to a Runtime slot.");
  }
  const stateDir = runtimeSlotConfig(slot).stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, ACTIVE_WORKSPACE_BINDING_FILE);
  const temp = target + ".tmp-" + process.pid;
  fs.writeFileSync(temp, id + "\n", "utf8");
  fs.rmSync(target, { force: true });
  fs.renameSync(temp, target);
}

export function runtimeSlotWorkspaceBinding(
  slot: RuntimeSlotId
): string | undefined {
  const target = path.join(
    runtimeSlotConfig(slot).stateDir,
    ACTIVE_WORKSPACE_BINDING_FILE
  );
  if (!fs.existsSync(target)) return undefined;
  const id = fs.readFileSync(target, "utf8").trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) ? id : undefined;
}

type BridgeMetadata = {
  version: number;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
};

function taskStateName(value: unknown): string {
  const numeric = Number(value);
  switch (numeric) {
    case 1: return "disabled";
    case 2: return "queued";
    case 3: return "ready";
    case 4: return "running";
    default: return "unknown";
  }
}

async function powershellJson<T>(script: string): Promise<T | undefined> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 512 * 1024
    }
  );
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as T;
}

async function taskStatus(taskName: string) {
  try {
    const result = await powershellJson<{
      TaskName?: string;
      State?: number;
      LastRunTime?: string;
      LastTaskResult?: number;
    }>(
      `$t=Get-ScheduledTask -TaskName '${taskName}';` +
      `$i=Get-ScheduledTaskInfo -TaskName '${taskName}';` +
      `[pscustomobject]@{TaskName=$t.TaskName;State=[int]$t.State;LastRunTime=$i.LastRunTime.ToString('o');LastTaskResult=$i.LastTaskResult}|ConvertTo-Json -Compress`
    );
    return {
      exists: true,
      name: result?.TaskName ?? taskName,
      state: taskStateName(result?.State),
      lastRunTime: result?.LastRunTime,
      lastTaskResult: result?.LastTaskResult
    };
  } catch {
    return {
      exists: false,
      name: taskName,
      state: "missing"
    };
  }
}

async function processStatus() {
  try {
    const rows = await powershellJson<
      Array<{
        ProcessId: number;
        Name: string;
        CreationDate?: string;
        ExecutablePath?: string;
        CommandLine?: string;
      }> | {
        ProcessId: number;
        Name: string;
        CreationDate?: string;
        ExecutablePath?: string;
        CommandLine?: string;
      }
    >(
      `$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |` +
      `Where-Object { ($_.Name -eq 'tunnel-client.exe' -and ($_.CommandLine -like '*--profile ${runtimeSlotConfig("A").profileName}*' -or $_.CommandLine -like '*--profile ${runtimeSlotConfig("B").profileName}*')) -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*launch-runtime.mjs*' -or $_.CommandLine -like '*dist*operator*server.js*')) } |` +
      `Select-Object ProcessId,Name,CreationDate,ExecutablePath,CommandLine;` +
      `@($p)|ConvertTo-Json -Compress`
    );
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    return list.map((row) => {
      const command = row.CommandLine ?? "";
      const role =
        row.Name === "tunnel-client.exe"
          ? "Tunnel"
          : /dist[\\/]operator[\\/]server\.js/i.test(command)
            ? "Operator Console"
            : /dist[\\/]index\.js/i.test(command)
              ? "MCP Server"
              : "P05 Node";
      return {
        Id: row.ProcessId,
        ProcessName: row.Name.replace(/\.exe$/i, ""),
        StartTime: row.CreationDate,
        Path: row.ExecutablePath,
        CommandLine: command,
        Role: role
      };
    });
  } catch {
    return [];
  }
}

async function healthStatus(urlFile = runtimeSlotConfig("A").healthUrlFile) {
  if (!fs.existsSync(urlFile)) {
    return {
      urlFile,
      baseUrl: null,
      live: false,
      ready: false
    };
  }

  const baseUrl = fs.readFileSync(urlFile, "utf8").trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    return {
      urlFile,
      baseUrl,
      live: false,
      ready: false,
      error: "invalid health URL"
    };
  }

  const fetchText = async (suffix: string) => {
    const response = await fetch(baseUrl + suffix, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store"
    });
    return {
      ok: response.ok,
      status: response.status,
      text: (await response.text()).trim()
    };
  };

  try {
    const [health, ready] = await Promise.all([
      fetchText("/healthz"),
      fetchText("/readyz")
    ]);
    return {
      urlFile,
      baseUrl,
      live: health.ok,
      ready: ready.ok,
      health,
      readiness: ready
    };
  } catch (error) {
    return {
      urlFile,
      baseUrl,
      live: false,
      ready: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

type BridgeMetadataCandidate = BridgeMetadata & {
  metadataPath: string;
  modifiedMs: number;
};

function bridgeMetadataCandidates(stateDir = runtimeSlotConfig("A").stateDir): BridgeMetadataCandidate[] {
  if (!fs.existsSync(stateDir)) return [];

  const candidates: BridgeMetadataCandidate[] = [];
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^operator-bridge(?:-\d+)?\.json$/.test(entry.name)
    ) {
      continue;
    }

    const metadataPath = path.join(stateDir, entry.name);
    try {
      const parsed = JSON.parse(
        fs.readFileSync(metadataPath, "utf8")
      ) as Partial<BridgeMetadata>;
      if (
        parsed.version !== 1 ||
        typeof parsed.url !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url) ||
        typeof parsed.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.token) ||
        typeof parsed.pid !== "number" ||
        !Number.isInteger(parsed.pid) ||
        parsed.pid <= 0 ||
        typeof parsed.startedAt !== "string"
      ) {
        continue;
      }

      candidates.push({
        ...(parsed as BridgeMetadata),
        metadataPath,
        modifiedMs: fs.statSync(metadataPath).mtimeMs
      });
    } catch {
      // Ignore malformed or concurrently replaced metadata.
    }
  }

  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function requestBridge(
  metadata: BridgeMetadata,
  pathname: string,
  init?: RequestInit,
  timeoutMs = 3500
): Promise<unknown> {
  const response = await fetch(metadata.url + pathname, {
    ...init,
    headers: {
      "authorization": `Bearer ${metadata.token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store"
  });

  const payload = await response.json() as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Bridge request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

async function resolveBridge(stateDir = runtimeSlotConfig("A").stateDir): Promise<{
  metadata: BridgeMetadata;
  overview: unknown;
}> {
  const candidates = bridgeMetadataCandidates(stateDir);
  for (const candidate of candidates) {
    if (!processAlive(candidate.pid)) continue;
    try {
      const overview = await requestBridge(
        candidate,
        "/api/overview",
        undefined,
        1500
      );
      return { metadata: candidate, overview };
    } catch {
      // A live PID can still own stale or unreachable metadata. Try the next.
    }
  }

  throw new Error(
    candidates.length > 0
      ? "P05 local control bridge metadata is stale or unreachable."
      : "P05 local control bridge is offline."
  );
}

export async function bridgeRequest(
  pathname: string,
  init?: RequestInit
): Promise<unknown> {
  const resolved = await resolveBridge();
  if (pathname === "/api/overview" && !init) return resolved.overview;
  return requestBridge(resolved.metadata, pathname, init);
}

export async function bridgeRequestForSlot(
  slot: RuntimeSlotId,
  pathname: string,
  init?: RequestInit
): Promise<unknown> {
  assertRuntimeSlotConfigured(slot);
  const config = runtimeSlotConfig(slot);
  const resolved = await resolveBridge(config.stateDir);
  if (pathname === "/api/overview" && !init) return resolved.overview;
  return requestBridge(resolved.metadata, pathname, init);
}

async function bridgeOverviewForStateDir(stateDir: string) {
  try {
    const resolved = await resolveBridge(stateDir);
    return {
      online: true,
      data: resolved.overview
    };
  } catch (error) {
    return {
      online: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function bridgeOverview() {
  try {
    return {
      online: true,
      data: await bridgeRequest("/api/overview")
    };
  } catch (error) {
    return {
      online: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function gitStatus(root: string | undefined) {
  if (!root) return { available: false, output: "" };

  const run = async (args: string[]) => {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, ...args],
      {
        windowsHide: true,
        timeout: 7000,
        maxBuffer: 512 * 1024
      }
    );
    return stdout.trimEnd();
  };

  try {
    const [statusText, unstagedStat, stagedStat, lastCommit] =
      await Promise.all([
        run(["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
        run(["diff", "--stat", "--no-ext-diff"]),
        run(["diff", "--cached", "--stat", "--no-ext-diff"]),
        run(["log", "-1", "--format=%h%x09%an%x09%ad%x09%s", "--date=iso-strict"])
      ]);

    const lines = statusText.split(/\r?\n/).filter(Boolean);
    const header = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
    const files = lines.slice(0, 120).map((line) => {
      const status = line.slice(0, 2);
      return {
        status,
        path: line.slice(3),
        staged: status[0] !== " " && status[0] !== "?",
        modified: status[1] !== " " && status[1] !== "?",
        untracked: status === "??",
        conflicted:
          status.includes("U") ||
          status === "AA" ||
          status === "DD"
      };
    });

    const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? "0");
    const behind = Number(header.match(/behind (\d+)/)?.[1] ?? "0");
    const branchPart = header.split(" [")[0] ?? "";
    const branch = (branchPart.split("...")[0] ?? branchPart).trim();
    const upstream = branchPart.includes("...")
      ? branchPart.split("...").slice(1).join("...").trim()
      : undefined;

    const last = lastCommit
      ? (() => {
          const [hash, author, date, ...subject] = lastCommit.split("\t");
          return {
            hash: hash ?? "",
            author: author ?? "",
            date: date ?? "",
            subject: subject.join("\t")
          };
        })()
      : undefined;

    return {
      available: true,
      output: statusText.trim(),
      branch,
      upstream,
      ahead,
      behind,
      dirty: files.length > 0,
      counts: {
        staged: files.filter((item) => item.staged).length,
        modified: files.filter((item) => item.modified).length,
        untracked: files.filter((item) => item.untracked).length,
        conflicted: files.filter((item) => item.conflicted).length
      },
      files,
      diffStat: {
        unstaged: unstagedStat,
        staged: stagedStat
      },
      lastCommit: last
    };
  } catch {
    return { available: false, output: "" };
  }
}

function logTail(
  limit = 30,
  logFile = runtimeSlotConfig("A").tunnelLog
): string[] {
  if (!fs.existsSync(logFile)) return [];
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

export async function runtimeSlotOverview(slot: RuntimeSlotId) {
  const config = runtimeSlotConfig(slot);
  let configured = false;
  let configurationError: string | undefined;
  try {
    configured = runtimeSlotConfigured(slot);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }

  if (!configured) {
    return {
      id: config.id,
      connector: config.connector,
      configured: false,
      tunnelAlias: config.profileName,
      connected: false,
      health: {
        urlFile: config.healthUrlFile,
        baseUrl: null,
        live: false,
        ready: false
      },
      bridge: {
        online: false,
        ...(configurationError ? { error: configurationError } : {})
      }
    };
  }

  const [health, bridge] = await Promise.all([
    healthStatus(config.healthUrlFile),
    bridgeOverviewForStateDir(config.stateDir)
  ]);

  const bridgeData =
    bridge.online && bridge.data && typeof bridge.data === "object"
      ? bridge.data as Record<string, unknown>
      : undefined;

  return {
    id: config.id,
    connector: config.connector,
    configured: true,
    tunnelAlias: config.profileName,
    boundWorkspaceId: runtimeSlotWorkspaceBinding(slot),
    connected: Boolean(health.ready && bridge.online),
    health,
    bridge: {
      online: bridge.online,
      ...(bridge.online
        ? {}
        : { error: bridge.error })
    },
    workspace:
      bridgeData?.workspace && typeof bridgeData.workspace === "object"
        ? bridgeData.workspace
        : undefined,
    device:
      bridgeData?.device && typeof bridgeData.device === "object"
        ? bridgeData.device
        : undefined
  };
}

export async function runtimeSlotsOverview() {
  const [A, B] = await Promise.all([
    runtimeSlotOverview("A"),
    runtimeSlotOverview("B")
  ]);
  return { A, B };
}

export async function operatorOverview() {
  const [processes, health, bridge, slots] = await Promise.all([
    processStatus(),
    healthStatus(),
    bridgeOverview(),
    runtimeSlotsOverview()
  ]);

  const bridgeData =
    bridge.online && bridge.data && typeof bridge.data === "object"
      ? bridge.data as Record<string, unknown>
      : undefined;

  const workspace =
    bridgeData?.workspace &&
    typeof bridgeData.workspace === "object"
      ? (bridgeData.workspace as {
          current?: { root?: string };
        }).current
      : undefined;

  const git = await gitStatus(workspace?.root);

  return {
    timestamp: new Date().toISOString(),
    connection: {
      connected: Boolean(health.ready && bridge.online),
      runtimeTask: {
        exists: false,
        name: "manual-slot-a",
        state: "manual"
      },
      restartTask: {
        exists: false,
        name: "manual-restart",
        state: "manual"
      },
      health,
      bridge: {
        online: bridge.online,
        ...(bridge.online
          ? { data: bridge.data }
          : { error: bridge.error })
      },
      processes
    },
    git,
    slots,
    logTail: logTail(25)
  };
}

export async function chooseWorkspaceFolder(): Promise<{ selected: boolean; path?: string }> {
  if (process.platform !== "win32") {
    throw new Error("Native folder selection is only available on Windows.");
  }

  const pickerScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择 MCP 工作目录"',
    '$dialog.ShowNewFolderButton = $false',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [System.IO.File]::WriteAllText($env:P05_PICKER_RESULT, $dialog.SelectedPath, [System.Text.Encoding]::UTF8)',
    '}'
  ].join("; ");
  const encodedPicker = Buffer.from(pickerScript, "utf16le").toString("base64");
  const launcherScript = [
    '$ErrorActionPreference = "Stop"',
    '$resultFile = [System.IO.Path]::GetTempFileName()',
    '$env:P05_PICKER_RESULT = $resultFile',
    `$picker = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoLogo","-NoProfile","-STA","-EncodedCommand","${encodedPicker}") -WindowStyle Normal -PassThru`,
    '$picker.WaitForExit()',
    '$selected = ""',
    'if (Test-Path -LiteralPath $resultFile) {',
    '  $selected = [System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8)',
    '  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue',
    '}',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::Write($selected)'
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launcherScript],
    {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024
    }
  );
  const selectedPath = stdout.trim();
  return selectedPath
    ? { selected: true, path: selectedPath }
    : { selected: false };
}
async function runSlotControlScript(
  scriptName: "run-runtime-slot.ps1" | "stop-runtime-slot.ps1" | "restart-runtime-slot.ps1",
  slot: RuntimeSlotId
) {
  const script = path.resolve(
    process.cwd(),
    "scripts",
    "deployment",
    scriptName
  );
  await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Slot",
      slot
    ],
    {
      windowsHide: true,
      timeout: 45_000,
      maxBuffer: 256 * 1024
    }
  );
}

export async function connectRuntime() {
  return connectRuntimeSlot("A");
}

export async function restartRuntime() {
  return restartRuntimeSlot("A");
}

export async function disconnectRuntime() {
  return disconnectRuntimeSlot("A");
}

export async function connectRuntimeSlot(slot: RuntimeSlotId) {
  assertRuntimeSlotConfigured(slot);
  await runSlotControlScript("run-runtime-slot.ps1", slot);
  return {
    ok: true,
    action: "connect",
    slot,
    message: `Runtime ${slot} connected.`
  };
}

export async function disconnectRuntimeSlot(slot: RuntimeSlotId) {
  await runSlotControlScript("stop-runtime-slot.ps1", slot);
  return {
    ok: true,
    action: "disconnect",
    slot,
    message: `Runtime ${slot} disconnected.`
  };
}

export async function restartRuntimeSlot(slot: RuntimeSlotId) {
  assertRuntimeSlotConfigured(slot);
  await runSlotControlScript("restart-runtime-slot.ps1", slot);
  return {
    ok: true,
    action: "restart",
    slot,
    message: `Runtime ${slot} restarted.`
  };
}

export const operatorConfigView = {
  mode: "repo-local-manual",
  tunnelClient: TUNNEL_CLIENT,
  profileDir: TUNNEL_PROFILE_DIR,
  runtimeA: {
    configured: (() => { try { return runtimeSlotConfigured("A"); } catch { return false; } })(),
    profile: runtimeSlotConfig("A").profileName,
    stateDir: runtimeSlotConfig("A").stateDir
  },
  runtimeB: {
    configured: (() => { try { return runtimeSlotConfigured("B"); } catch { return false; } })(),
    profile: runtimeSlotConfig("B").profileName,
    stateDir: runtimeSlotConfig("B").stateDir
  }
};
