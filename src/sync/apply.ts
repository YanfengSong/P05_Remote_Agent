import fs from "node:fs";
import path from "node:path";
import type { GoldenState } from "./types.js";
import { writeApprovalMode } from "../policy/approval-mode.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

type LocalWorkspace = {
  id: string;
  root: string;
  kind: string;
  label?: string;
  plugins?: string[];
};

type LocalReference = {
  id: string;
  label: string;
  root: string;
};

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJson(filePath: string): any | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(readUtf8(filePath));
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + ".tmp-" + process.pid;
  fs.writeFileSync(temp, content, "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temp, filePath);
}

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1));
  }
  return values;
}

function setEnvValue(text: string, name: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    const index = lines[i]!.indexOf("=");
    const key = index > 0 ? lines[i]!.slice(0, index).trim() : "";
    if (key === name) {
      lines[i] = name + "=" + value;
      found = true;
      break;
    }
  }
  if (!found) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(name + "=" + value);
  }
  return lines.join("\r\n") + "\r\n";
}

function parseWorkspaceRegistry(raw: string | undefined): LocalWorkspace[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Local P05_WORKSPACES_JSON must be an array.");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Local workspace entry " + index + " is invalid.");
    }
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const root = typeof value.root === "string" ? value.root.trim() : "";
    const kind = typeof value.kind === "string" ? value.kind.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : undefined;
    const plugins = Array.isArray(value.plugins)
      ? value.plugins.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : undefined;
    if (!id || !root || !kind) {
      throw new Error("Local workspace entry " + index + " requires id, root and kind.");
    }
    return { id, root: path.resolve(root), kind, ...(label ? { label } : {}), ...(plugins?.length ? { plugins } : {}) };
  });
}

function parseReferenceRegistry(filePath: string): LocalReference[] {
  const parsed = readJson(filePath);
  if (!parsed) return [];
  if (parsed.version !== 1 || !Array.isArray(parsed.references)) {
    throw new Error("Local reference registry must use version 1.");
  }
  return parsed.references.map((entry: any, index: number) => {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const root = typeof entry?.root === "string" ? entry.root.trim() : "";
    if (!id || !label || !root) throw new Error("Local reference entry " + index + " is invalid.");
    return { id, label, root: path.resolve(root) };
  });
}

function loadRootMap(filePath: string): Record<string, string> {
  const parsed = readJson(filePath);
  if (!parsed) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sync-workspace-map.json must be an object mapping workspace ids to local roots.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Workspace root map entry \"" + key + "\" must be a non-empty string.");
    }
    result[key.toLowerCase()] = path.resolve(value);
  }
  return result;
}

function isInside(candidate: string, roots: string[]): boolean {
  const value = path.resolve(candidate);
  return roots.some((root) => {
    const base = path.resolve(root);
    const a = process.platform === "win32" ? value.toLowerCase() : value;
    const b = process.platform === "win32" ? base.toLowerCase() : base;
    return a === b || a.startsWith(b + path.sep);
  });
}

function applyWorkspaces(
  desired: GoldenState,
  envValues: Map<string, string>,
  mapPath: string
): { configuredJson: string; persistentJson: string } {
  const current = parseWorkspaceRegistry(envValues.get("P05_WORKSPACES_JSON"));
  const persistentPath = path.join(repoRoot, ".p05", "workspaces.json");
  const persistent = parseWorkspaceRegistry(
    (() => {
      const parsed = readJson(persistentPath);
      if (!parsed) return undefined;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
        throw new Error("Local persistent workspace registry must use version 1.");
      }
      return JSON.stringify(parsed.workspaces);
    })()
  );
  const allCurrent = [...current, ...persistent];
  const map = loadRootMap(mapPath);
  const allowedRoots = (envValues.get("REMOTE_AGENT_ALLOWED_ROOTS") || "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  if (allowedRoots.length === 0) {
    throw new Error("REMOTE_AGENT_ALLOWED_ROOTS must be configured before State Sync can apply Workspace bindings.");
  }

  const result = desired.workspace.entries.map((entry) => {
    const currentMatch = allCurrent.find((item) => item.id.toLowerCase() === entry.id.toLowerCase());
    const root = entry.kind === "platform-source"
      ? repoRoot
      : currentMatch?.root || map[entry.id.toLowerCase()];

    if (!root) {
      throw new Error(
        "Workspace \"" + entry.id + "\" exists in Golden State but has no local root. " +
        "Register it locally or create " + path.relative(repoRoot, mapPath) +
        " with a mapping for \"" + entry.id + "\"."
      );
    }

    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error("Workspace \"" + entry.id + "\" local root does not exist: " + root);
    }
    if (!isInside(root, allowedRoots)) {
      throw new Error("Workspace \"" + entry.id + "\" local root is outside REMOTE_AGENT_ALLOWED_ROOTS: " + root);
    }

    return {
      id: entry.id,
      root: path.resolve(root),
      kind: entry.kind,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.plugins?.length ? { plugins: entry.plugins } : {})
    };
  });

  const active = desired.workspace.activeId;
  if (!result.some((entry) => entry.id.toLowerCase() === active.toLowerCase())) {
    throw new Error("Golden State active Workspace \"" + active + "\" is not present in the desired registry.");
  }

  const platform = result.filter((entry) => entry.kind === "platform-source");
  const business = result
    .filter((entry) => entry.kind !== "platform-source")
    .map((entry) => ({
      id: entry.id,
      root: entry.root,
      kind: entry.kind,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.plugins?.length ? { plugins: entry.plugins } : {})
    }));

  return {
    configuredJson: JSON.stringify(platform, null, 2),
    persistentJson: JSON.stringify({ version: 1, workspaces: business }, null, 2)
  };
}

function applyReferences(desired: GoldenState, stateDir: string): boolean {
  const filePath = path.join(stateDir, "references.json");
  const current = parseReferenceRegistry(filePath);
  const result = desired.references.map((entry) => {
    const match = current.find((item) => item.id.toLowerCase() === entry.id.toLowerCase());
    if (!match) {
      throw new Error(
        "Reference \"" + entry.id + "\" exists in Golden State but has no local root. " +
        "Register the reference root on this machine before syncing."
      );
    }
    if (!fs.existsSync(match.root) || !fs.statSync(match.root).isDirectory()) {
      throw new Error("Reference \"" + entry.id + "\" local root does not exist: " + match.root);
    }
    return { id: entry.id, label: entry.label, root: match.root };
  });

  const before = fs.existsSync(filePath) ? readUtf8(filePath) : "";
  const after = JSON.stringify({ version: 1, references: result }, null, 2) + "\n";
  if (before === after) return false;
  writeAtomic(filePath, after);
  return true;
}

export function applyGoldenState(desired: GoldenState): {
  changed: string[];
  workspaceCount: number;
  referenceCount: number;
} {
  if (desired.kind !== "p05-golden-state" || desired.schemaVersion !== 1) {
    throw new Error("Unsupported Golden State schema.");
  }

  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env is missing. Run the machine bootstrap before State Sync.");
  }

  const stateDir = path.join(repoRoot, ".p05");
  const envBefore = readUtf8(envPath);
  const envValues = parseEnv(envBefore);
  const changed: string[] = [];

  const workspaceState = applyWorkspaces(
    desired,
    envValues,
    path.join(stateDir, "sync-workspace-map.json")
  );

  let envAfter = envBefore;
  envAfter = setEnvValue(envAfter, "P05_TOOL_PROFILE", desired.policy.toolProfile);
  envAfter = setEnvValue(envAfter, "P05_RUNTIME_SLOTS", desired.runtime.slots.map((slot) => slot.id).join(","));
  envAfter = setEnvValue(envAfter, "P05_RUNTIME_A_PROFILE", desired.runtime.slots.find((slot) => slot.id === "A")?.profileName || "p05-a");
  envAfter = setEnvValue(envAfter, "P05_RUNTIME_B_PROFILE", desired.runtime.slots.find((slot) => slot.id === "B")?.profileName || "p05-b");
  envAfter = setEnvValue(envAfter, "P05_ACTIVE_WORKSPACE_ID", desired.workspace.activeId);
  envAfter = setEnvValue(envAfter, "P05_WORKSPACES_JSON", workspaceState.configuredJson);

  if (envAfter !== envBefore) {
    writeAtomic(envPath, envAfter);
    changed.push(".env");
  }

  const workspacePath = path.join(stateDir, "workspaces.json");
  const workspaceBefore = fs.existsSync(workspacePath) ? readUtf8(workspacePath) : "";
  const workspaceAfter = workspaceState.persistentJson + "\n";
  if (workspaceBefore !== workspaceAfter) {
    writeAtomic(workspacePath, workspaceAfter);
    changed.push(".p05/workspaces.json");
  }

  const approvalPath = path.join(stateDir, "approval-mode.json");
  const approvalBefore = fs.existsSync(approvalPath) ? readUtf8(approvalPath) : "";
  let currentApproval: string | undefined;
  if (approvalBefore) {
    try {
      const parsed = JSON.parse(approvalBefore) as { mode?: unknown };
      if (typeof parsed.mode === "string") currentApproval = parsed.mode;
    } catch {}
  }
  if (currentApproval !== desired.policy.approvalMode) {
    writeApprovalMode(desired.policy.approvalMode as "standard" | "trusted");
    changed.push(".p05/approval-mode.json");
  }

  if (applyReferences(desired, stateDir)) changed.push(".p05/references.json");

  return {
    changed,
    workspaceCount: desired.workspace.entries.length,
    referenceCount: desired.references.length
  };
}
