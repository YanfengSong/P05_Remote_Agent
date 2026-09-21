import fs from "node:fs";
import path from "node:path";
import type { WorkspaceDescriptor, WorkspaceKind } from "./types.js";
import { parseWorkspaceRegistry } from "./manager.js";

export type PersistentWorkspaceEntry = {
  id: string;
  root: string;
  kind: Exclude<WorkspaceKind, "platform-source">;
  label?: string;
  plugins?: readonly string[];
};

type PersistentWorkspaceFile = {
  version: 1;
  workspaces: PersistentWorkspaceEntry[];
};

function plain(entry: WorkspaceDescriptor | PersistentWorkspaceEntry) {
  return {
    id: entry.id,
    root: entry.root,
    kind: entry.kind,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.plugins ? { plugins: [...entry.plugins] } : {})
  };
}

export function loadPersistentWorkspaceEntries(filePath: string): PersistentWorkspaceEntry[] {
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Persistent workspace registry must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Persistent workspace registry must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.workspaces)) {
    throw new Error("Persistent workspace registry must use version 1.");
  }
  return record.workspaces.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Persistent workspace entry ${index} must be an object.`);
    }
    const value = item as Record<string, unknown>;
    if (value.kind === "platform-source") {
      throw new Error("Persistent workspace entries cannot redefine the platform workspace.");
    }
    return {
      id: typeof value.id === "string" ? value.id : "",
      root: typeof value.root === "string" ? value.root : "",
      kind: value.kind as PersistentWorkspaceEntry["kind"],
      ...(typeof value.label === "string" ? { label: value.label } : {}),
      ...(Array.isArray(value.plugins) ? { plugins: value.plugins as string[] } : {})
    };
  });
}

export function mergePersistentWorkspaces(
  configured: readonly WorkspaceDescriptor[],
  persistent: readonly PersistentWorkspaceEntry[],
  allowedRoots: readonly string[],
  defaultRoot: string
): WorkspaceDescriptor[] {
  const raw = JSON.stringify([
    ...configured.map(plain),
    ...persistent.map(plain)
  ]);
  return parseWorkspaceRegistry(raw, allowedRoots, defaultRoot);
}

export function toPersistentWorkspaceEntry(
  workspace: WorkspaceDescriptor
): PersistentWorkspaceEntry {
  if (workspace.kind === "platform-source") {
    throw new Error("Platform workspace cannot be persisted as an operator workspace.");
  }
  return {
    id: workspace.id,
    root: workspace.root,
    kind: workspace.kind,
    ...(workspace.label ? { label: workspace.label } : {}),
    ...(workspace.plugins ? { plugins: [...workspace.plugins] } : {})
  };
}

export function savePersistentWorkspaceEntries(
  filePath: string,
  entries: readonly PersistentWorkspaceEntry[]
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: PersistentWorkspaceFile = {
    version: 1,
    workspaces: entries.map((entry) => ({ ...entry, ...(entry.plugins ? { plugins: [...entry.plugins] } : {}) }))
  };
  const tempPath = filePath + ".tmp-" + process.pid;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(tempPath, filePath);
}
