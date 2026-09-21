import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WORKSPACE_AUTHORIZATION, WORKSPACE_KINDS, type WorkspaceDescriptor, type WorkspaceKind, type WorkspaceView } from "./types.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function insideAnyRoot(candidate: string, allowedRoots: readonly string[]): boolean {
  const value = normalize(candidate);
  return allowedRoots.some((root) => {
    const base = normalize(root);
    return value === base || value.startsWith(base + path.sep);
  });
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

function workspaceIdBase(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 56);
  return normalized || "workspace";
}

export function parseWorkspaceRegistry(
  raw: string | undefined,
  allowedRoots: readonly string[],
  defaultRoot: string
): WorkspaceDescriptor[] {
  if (!raw?.trim()) {
    const resolved = path.resolve(defaultRoot);
    const realRoot = fs.realpathSync(resolved);
    if (!insideAnyRoot(realRoot, allowedRoots)) {
      throw new Error("Default platform workspace resolves outside REMOTE_AGENT_ALLOWED_ROOTS.");
    }
    return [{
      id: "platform",
      root: realRoot,
      kind: "platform-source",
      label: "P05 platform workspace",
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("P05_WORKSPACES_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("P05_WORKSPACES_JSON must be a non-empty JSON array.");
  }

  const result: WorkspaceDescriptor[] = [];
  const ids = new Set<string>();
  const roots = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("Each workspace entry must be an object.");
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const root = typeof record.root === "string" ? record.root.trim() : "";
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
    const kind = record.kind ?? "generic";
    let plugins: string[] | undefined;
    if (record.plugins !== undefined) {
      if (!Array.isArray(record.plugins) || !record.plugins.every((value) => typeof value === "string")) {
        throw new Error(`Workspace "${id}" plugins must be a JSON array of plugin ids.`);
      }
      plugins = record.plugins.map((value) => value.trim());
      if (plugins.some((value) => !ID_PATTERN.test(value))) {
        throw new Error(`Workspace "${id}" contains an invalid plugin id.`);
      }
      if (new Set(plugins.map((value) => value.toLowerCase())).size !== plugins.length) {
        throw new Error(`Workspace "${id}" contains duplicate plugin ids.`);
      }
    }

    if (!ID_PATTERN.test(id)) throw new Error(`Invalid workspace id "${id}".`);
    if (!path.isAbsolute(root)) throw new Error(`Workspace "${id}" root must be absolute.`);
    if (!isWorkspaceKind(kind)) {
      throw new Error(`Workspace "${id}" kind must be one of: ${WORKSPACE_KINDS.join(", ")}.`);
    }

    const resolved = path.resolve(root);
    if (!insideAnyRoot(resolved, allowedRoots)) {
      throw new Error(`Workspace "${id}" is outside REMOTE_AGENT_ALLOWED_ROOTS.`);
    }
    let stat: fs.Stats;
    let realRoot: string;
    try {
      stat = fs.statSync(resolved);
      realRoot = fs.realpathSync(resolved);
    } catch {
      throw new Error(`Workspace "${id}" root does not exist or cannot be resolved.`);
    }
    if (!stat.isDirectory()) throw new Error(`Workspace "${id}" root is not a directory.`);
    if (!insideAnyRoot(realRoot, allowedRoots)) {
      throw new Error(`Workspace "${id}" resolves outside REMOTE_AGENT_ALLOWED_ROOTS.`);
    }

    const idKey = id.toLowerCase();
    const rootKey = normalize(realRoot);
    if (ids.has(idKey)) throw new Error(`Duplicate workspace id "${id}".`);
    if (roots.has(rootKey)) throw new Error(`Duplicate workspace root for "${id}".`);
    ids.add(idKey);
    roots.add(rootKey);
    result.push({
      id,
      root: realRoot,
      kind,
      ...(label ? { label } : {}),
      ...(plugins ? { plugins } : {}),
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    });
  }

  const platforms = result.filter((entry) => entry.kind === "platform-source");
  if (platforms.length !== 1) {
    throw new Error(`P05_WORKSPACES_JSON must declare exactly one platform-source workspace; got ${platforms.length}.`);
  }

  return result;
}

export class WorkspaceManager {
  readonly #workspaces: WorkspaceDescriptor[];
  #sessionWorkspace?: WorkspaceDescriptor;
  #currentId: string;

  constructor(workspaces: readonly WorkspaceDescriptor[], initialId?: string) {
    if (workspaces.length === 0) throw new Error("At least one workspace is required.");
    this.#workspaces = [...workspaces];
    const selected = initialId?.trim() || workspaces[0]!.id;
    const match = this.#workspaces.find((entry) => entry.id.toLowerCase() === selected.toLowerCase());
    if (!match) throw new Error(`P05_ACTIVE_WORKSPACE_ID "${selected}" is not registered.`);
    this.#currentId = match.id;
  }

  list(): WorkspaceView[] {
    const entries = this.#sessionWorkspace
      ? [...this.#workspaces, this.#sessionWorkspace]
      : [...this.#workspaces];
    return entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.plugins ? { plugins: [...entry.plugins] } : {}),
      current: entry.id === this.#currentId,
      platform: entry.kind === "platform-source",
      authorization: { ...entry.authorization }
    }));
  }

  get(id: string): WorkspaceDescriptor {
    const key = id.trim().toLowerCase();
    const match = this.#workspaces.find(
      (entry) => entry.id.toLowerCase() === key
    ) ?? (this.#sessionWorkspace?.id.toLowerCase() === key ? this.#sessionWorkspace : undefined);
    if (!match) throw new Error(`Workspace "${id}" is not registered.`);
    return match;
  }

  all(): WorkspaceDescriptor[] {
    const entries = this.#sessionWorkspace
      ? [...this.#workspaces, this.#sessionWorkspace]
      : [...this.#workspaces];
    return entries.map((entry) => ({
      ...entry,
      ...(entry.plugins ? { plugins: [...entry.plugins] } : {}),
      authorization: { ...entry.authorization }
    }));
  }

  current(): WorkspaceDescriptor {
    return this.get(this.#currentId);
  }

  currentRoot(): string {
    return this.current().root;
  }

  platform(): WorkspaceDescriptor {
    const platform = this.#workspaces.find((entry) => entry.kind === "platform-source");
    if (!platform) throw new Error("Platform workspace is not registered.");
    return platform;
  }

  platformRoot(): string {
    return this.platform().root;
  }

  pluginAllowed(pluginId: string, workspace = this.current()): boolean {
    return workspace.plugins === undefined ||
      workspace.plugins.some((id) => id.toLowerCase() === pluginId.toLowerCase());
  }

  setSessionRoot(root: string, allowedRoots: readonly string[]): WorkspaceView {
    const candidate = root.trim();
    if (!candidate) throw new Error("Workspace root is required.");
    if (!path.isAbsolute(candidate)) throw new Error("Workspace root must be an absolute path.");

    const resolved = path.resolve(candidate);
    if (!insideAnyRoot(resolved, allowedRoots)) {
      throw new Error("Workspace root is outside REMOTE_AGENT_ALLOWED_ROOTS.");
    }

    let stat: fs.Stats;
    let realRoot: string;
    try {
      stat = fs.statSync(resolved);
      realRoot = fs.realpathSync(resolved);
    } catch {
      throw new Error("Workspace root does not exist or cannot be resolved.");
    }
    if (!stat.isDirectory()) throw new Error("Workspace root is not a directory.");
    if (!insideAnyRoot(realRoot, allowedRoots)) {
      throw new Error("Workspace root resolves outside REMOTE_AGENT_ALLOWED_ROOTS.");
    }

    const registered = this.#workspaces.find(
      (entry) => normalize(entry.root) === normalize(realRoot)
    );
    if (registered) return this.switch(registered.id);

    const id = "operator-session";
    if (this.#workspaces.some((entry) => entry.id.toLowerCase() === id)) {
      throw new Error(`Workspace id "${id}" is reserved for the Operator Console.`);
    }

    this.#sessionWorkspace = {
      id,
      root: realRoot,
      kind: "generic",
      label: `Operator · ${path.basename(realRoot) || realRoot}`,
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    };
    this.#currentId = id;
    return {
      id,
      kind: "generic",
      label: this.#sessionWorkspace.label,
      current: true,
      platform: false,
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    };
  }

  persistentRegistrationCandidate(): WorkspaceDescriptor {
    const session = this.#sessionWorkspace;
    if (!session || this.#currentId !== session.id) {
      throw new Error("Current workspace is already registered.");
    }

    const label = path.basename(session.root) || "Workspace";
    const base = workspaceIdBase(label);
    const existing = new Set(this.#workspaces.map((entry) => entry.id.toLowerCase()));
    let id = base;
    for (let index = 2; existing.has(id.toLowerCase()) || id.toLowerCase() === "operator-session"; index += 1) {
      const suffix = `-${index}`;
      id = base.slice(0, Math.max(1, 64 - suffix.length)) + suffix;
    }

    return {
      id,
      root: session.root,
      kind: fs.existsSync(path.join(session.root, ".git")) ? "git-project" : "generic",
      label,
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    };
  }

  registerPersistentWorkspace(workspace: WorkspaceDescriptor): WorkspaceView {
    const session = this.#sessionWorkspace;
    if (!session || this.#currentId !== session.id) {
      throw new Error("Current workspace is already registered.");
    }
    if (workspace.kind === "platform-source") {
      throw new Error("Operator workspace cannot replace the platform workspace.");
    }
    if (!ID_PATTERN.test(workspace.id) || workspace.id.toLowerCase() === "operator-session") {
      throw new Error(`Invalid persistent workspace id "${workspace.id}".`);
    }
    if (normalize(workspace.root) !== normalize(session.root)) {
      throw new Error("Persistent workspace must match the current operator session root.");
    }
    if (this.#workspaces.some((entry) => entry.id.toLowerCase() === workspace.id.toLowerCase())) {
      throw new Error(`Workspace "${workspace.id}" is already registered.`);
    }
    if (this.#workspaces.some((entry) => normalize(entry.root) === normalize(workspace.root))) {
      throw new Error("Workspace root is already registered.");
    }

    const registered: WorkspaceDescriptor = {
      ...workspace,
      ...(workspace.plugins ? { plugins: [...workspace.plugins] } : {}),
      authorization: { ...DEFAULT_WORKSPACE_AUTHORIZATION }
    };
    this.#workspaces.push(registered);
    this.#sessionWorkspace = undefined;
    this.#currentId = registered.id;
    return {
      id: registered.id,
      kind: registered.kind,
      ...(registered.label ? { label: registered.label } : {}),
      ...(registered.plugins ? { plugins: [...registered.plugins] } : {}),
      current: true,
      platform: false,
      authorization: { ...registered.authorization }
    };
  }

  switch(id: string): WorkspaceView {
    const match = this.get(id);
    this.#currentId = match.id;
    return {
      id: match.id,
      kind: match.kind,
      ...(match.label ? { label: match.label } : {}),
      ...(match.plugins ? { plugins: [...match.plugins] } : {}),
      current: true,
      platform: match.kind === "platform-source",
      authorization: { ...match.authorization }
    };
  }
}