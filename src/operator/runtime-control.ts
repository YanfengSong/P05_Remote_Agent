import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { p05StatePath } from "../state.js";

const execFileAsync = promisify(execFile);

const RUNTIME_TASK = process.env.P05_OPERATOR_RUNTIME_TASK ?? "P05-Runtime";
const RESTART_TASK = process.env.P05_OPERATOR_RESTART_TASK ?? "P05-RestartBroker";
const TUNNEL_ALIAS = process.env.P05_OPERATOR_TUNNEL_ALIAS ?? "p05-boonray";
const TUNNEL_CLIENT =
  process.env.P05_OPERATOR_TUNNEL_CLIENT ??
  "D:\\Tools\\tunnel-client\\tunnel-client.exe";

const HEALTH_URL_FILE =
  process.env.P05_OPERATOR_HEALTH_URL_FILE ??
  path.join(
    os.homedir(),
    ".local",
    "state",
    "tunnel-client",
    "health",
    `${TUNNEL_ALIAS}.url`
  );

const TUNNEL_LOG =
  process.env.P05_OPERATOR_TUNNEL_LOG ??
  path.join(
    os.homedir(),
    ".local",
    "state",
    "tunnel-client",
    "logs",
    `${TUNNEL_ALIAS}.log`
  );

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
      `Where-Object { ($_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -like '*p05-boonray*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*P05_Remote_Agent*') } |` +
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

async function healthStatus() {
  if (!fs.existsSync(HEALTH_URL_FILE)) {
    return {
      urlFile: HEALTH_URL_FILE,
      baseUrl: null,
      live: false,
      ready: false
    };
  }

  const baseUrl = fs.readFileSync(HEALTH_URL_FILE, "utf8").trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    return {
      urlFile: HEALTH_URL_FILE,
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
      urlFile: HEALTH_URL_FILE,
      baseUrl,
      live: health.ok,
      ready: ready.ok,
      health,
      readiness: ready
    };
  } catch (error) {
    return {
      urlFile: HEALTH_URL_FILE,
      baseUrl,
      live: false,
      ready: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function readBridgeMetadata(): BridgeMetadata | undefined {
  const metadataPath = p05StatePath("operator-bridge.json");
  if (!fs.existsSync(metadataPath)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Partial<BridgeMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.url !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url) ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.token) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return parsed as BridgeMetadata;
  } catch {
    return undefined;
  }
}

export async function bridgeRequest(
  pathname: string,
  init?: RequestInit
): Promise<unknown> {
  const metadata = readBridgeMetadata();
  if (!metadata) throw new Error("P05 local control bridge is offline.");

  const response = await fetch(metadata.url + pathname, {
    ...init,
    headers: {
      "authorization": `Bearer ${metadata.token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    signal: AbortSignal.timeout(3500),
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

function logTail(limit = 30): string[] {
  if (!fs.existsSync(TUNNEL_LOG)) return [];
  try {
    const text = fs.readFileSync(TUNNEL_LOG, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

export async function operatorOverview() {
  const [runtimeTask, restartTask, processes, health, bridge] =
    await Promise.all([
      taskStatus(RUNTIME_TASK),
      taskStatus(RESTART_TASK),
      processStatus(),
      healthStatus(),
      bridgeOverview()
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
      runtimeTask,
      restartTask,
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
    logTail: logTail(25)
  };
}

export async function connectRuntime() {
  await execFileAsync(
    "schtasks.exe",
    ["/Run", "/TN", RUNTIME_TASK],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    }
  );
  return { ok: true, action: "connect", message: "P05 runtime start requested." };
}

export async function restartRuntime() {
  await execFileAsync(
    "schtasks.exe",
    ["/Run", "/TN", RESTART_TASK],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    }
  );
  return { ok: true, action: "restart", message: "P05 restart broker requested." };
}

export async function disconnectRuntime() {
  const warnings: string[] = [];

  if (fs.existsSync(TUNNEL_CLIENT)) {
    try {
      await execFileAsync(
        TUNNEL_CLIENT,
        ["runtimes", "stop", TUNNEL_ALIAS],
        {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 128 * 1024
        }
      );
    } catch (error) {
      warnings.push(
        "Tunnel runtime stop returned an error: " +
        (error instanceof Error ? error.message : String(error))
      );
    }
  } else {
    warnings.push("tunnel-client executable was not found.");
  }

  try {
    await execFileAsync(
      "schtasks.exe",
      ["/End", "/TN", RUNTIME_TASK],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      }
    );
  } catch {
    // It may already be stopped.
  }

  return {
    ok: true,
    action: "disconnect",
    message: "P05 disconnect requested.",
    warnings
  };
}

export const operatorConfigView = {
  runtimeTask: RUNTIME_TASK,
  restartTask: RESTART_TASK,
  tunnelAlias: TUNNEL_ALIAS,
  healthUrlFile: HEALTH_URL_FILE,
  tunnelLog: TUNNEL_LOG
};
