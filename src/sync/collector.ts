import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { readOwnEnv } from "../env.js";
import { readApprovalMode } from "../policy/approval-mode.js";
import { resolveToolProfile } from "../policy/tool-profile.js";
import { CAPABILITIES } from "../capability/registry.js";
import { BUILTIN_PLUGINS } from "../plugins/builtins.js";
import { PluginRegistry } from "../plugin/registry.js";
import { GOLDEN_STATE_SCHEMA_VERSION, type GoldenDownstream, type GoldenPlugin, type GoldenReference, type GoldenState, type GoldenWorkspace } from "./types.js";
import { stateRevision, sha256 } from "./canonical.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function stateDir(): string {
  const configured = readOwnEnv("P05_STATE_DIR")?.trim();
  return path.resolve(configured || path.join(repoRoot, ".p05"));
}

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function normalizeWorkspaceEntry(value: unknown, source: string): GoldenWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid workspace entry in ${source}.`);
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const label = typeof record.label === "string" && record.label.trim()
    ? record.label.trim()
    : undefined;
  const plugins = Array.isArray(record.plugins)
    ? record.plugins
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .sort()
    : undefined;
  if (!id || !kind) throw new Error(`Workspace in ${source} requires id and kind.`);
  return {
    id,
    kind,
    ...(label ? { label } : {}),
    ...(plugins?.length ? { plugins } : {}),
    rootBinding: "local"
  };
}

function collectWorkspaces(): { activeId: string; entries: GoldenWorkspace[] } {
  const entries: GoldenWorkspace[] = [];
  const configuredRaw = readOwnEnv("P05_WORKSPACES_JSON")?.trim();

  if (configuredRaw) {
    const parsed = JSON.parse(configuredRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("P05_WORKSPACES_JSON must be an array.");
    for (const entry of parsed) entries.push(normalizeWorkspaceEntry(entry, "P05_WORKSPACES_JSON"));
  } else {
    entries.push({
      id: "platform",
      kind: "platform-source",
      label: "P05 platform workspace",
      rootBinding: "local"
    });
  }

  const persistent = readJson(path.join(stateDir(), "workspaces.json"));
  if (persistent && typeof persistent === "object" && !Array.isArray(persistent)) {
    const workspaces = (persistent as Record<string, unknown>).workspaces;
    if (Array.isArray(workspaces)) {
      for (const entry of workspaces) {
        const normalized = normalizeWorkspaceEntry(entry, "persistent workspaces");
        if (entries.some((item) => item.id.toLowerCase() === normalized.id.toLowerCase())) {
          throw new Error(`Duplicate workspace id "${normalized.id}" across configured and persistent state.`);
        }
        entries.push(normalized);
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const requested = readOwnEnv("P05_ACTIVE_WORKSPACE_ID")?.trim();
  const activeId = requested ||
    entries.find((entry) => entry.kind === "platform-source")?.id ||
    entries[0]?.id;

  if (!activeId) throw new Error("No workspace is available for Golden State export.");
  const match = entries.find((entry) => entry.id.toLowerCase() === activeId.toLowerCase());
  if (!match) throw new Error(`Active workspace "${activeId}" is not registered.`);

  return { activeId: match.id, entries };
}

function collectReferences(): GoldenReference[] {
  const parsed = readJson(path.join(stateDir(), "references.json"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const references = (parsed as Record<string, unknown>).references;
  if (!Array.isArray(references)) return [];

  return references.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid reference root entry.");
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!id || !label) throw new Error("Reference root requires id and label.");
    return { id, label, rootBinding: "local" as const };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function collectPlugins(): { plugins: GoldenPlugin[]; downstream: GoldenDownstream[] } {
  const registry = new PluginRegistry(BUILTIN_PLUGINS);

  const plugins = registry.manifests().map((manifest) => ({
    id: manifest.id,
    label: manifest.label,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    enabled: manifest.enabled,
    permissions: { ...manifest.permissions },
    dependencies: (manifest.dependencies ?? []).map((entry) => ({
      id: entry.id,
      optional: entry.optional === true
    })).sort((a, b) => a.id.localeCompare(b.id))
  })).sort((a, b) => a.id.localeCompare(b.id));

  const downstream = registry.downstreamDefinitions().map((entry) => ({
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled,
    workspaceBinding: entry.workspaceBinding ?? "active",
    requestTimeoutMs: entry.requestTimeoutMs
  })).sort((a, b) => a.id.localeCompare(b.id));

  return { plugins, downstream };
}

export function collectGoldenState(): GoldenState {
  const toolProfile = resolveToolProfile(readOwnEnv("P05_TOOL_PROFILE")).profile;
  const workspace = collectWorkspaces();
  const { plugins, downstream } = collectPlugins();

  const capabilityCatalog = CAPABILITIES.map((entry) => ({ ...entry }));
  const base = {
    kind: "p05-golden-state" as const,
    schemaVersion: GOLDEN_STATE_SCHEMA_VERSION,
    source: {
      agentVersion: VERSION,
      gitCommit: git(["rev-parse", "HEAD"])
    },
    policy: {
      toolProfile,
      approvalMode: readApprovalMode().mode
    },
    runtime: {
      slots: (readOwnEnv("P05_RUNTIME_SLOTS")?.trim() || "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value): value is "A" | "B" => value === "A" || value === "B")
        .map((id) => ({
          id,
          profileName: id === "A"
            ? readOwnEnv("P05_RUNTIME_A_PROFILE")?.trim() || "p05-a"
            : readOwnEnv("P05_RUNTIME_B_PROFILE")?.trim() || "p05-b"
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    workspace,
    references: collectReferences(),
    plugins,
    downstream,
    capabilities: {
      names: capabilityCatalog.map((entry) => entry.name).sort(),
      catalogSha256: sha256(capabilityCatalog)
    }
  };

  return {
    ...base,
    generatedAt: new Date().toISOString(),
    revision: stateRevision(base)
  };
}

export function goldenStateComparable(state: GoldenState): unknown {
  const { generatedAt: _generatedAt, revision: _revision, ...comparable } = state;
  return comparable;
}
