import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createExecutionContext, type ExecutionContext } from "../runtime/context.js";
import type {
  IsolationAllocation,
  IsolationMode,
  IsolationRecord,
  IsolationView,
  ReconcilePlan
} from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_RECORDS = 200;
const MAX_ACTIVE_PER_WORKSPACE = 20;

type PersistedState = {
  version: 1;
  isolations: IsolationRecord[];
};

function now(): string {
  return new Date().toISOString();
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(candidate: string, root: string): boolean {
  const value = normalize(candidate);
  const base = normalize(root);
  return value === base || value.startsWith(base + path.sep);
}

function safeRecord(value: unknown): IsolationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<IsolationRecord>;
  if (
    typeof item.id !== "string" ||
    typeof item.workspaceId !== "string" ||
    typeof item.ownerActorType !== "string" ||
    typeof item.ownerActorId !== "string" ||
    (item.mode !== "workspace" && item.mode !== "worktree") ||
    (item.state !== "active" && item.state !== "released" && item.state !== "broken") ||
    typeof item.createdAt !== "string" ||
    typeof item.lastCheckedAt !== "string"
  ) return undefined;

  return {
    id: item.id,
    workspaceId: item.workspaceId,
    ownerActorType: item.ownerActorType as IsolationRecord["ownerActorType"],
    ownerActorId: item.ownerActorId,
    mode: item.mode,
    state: item.state,
    ...(typeof item.baseCommit === "string" ? { baseCommit: item.baseCommit } : {}),
    ...(typeof item.reconciledCommit === "string"
      ? { reconciledCommit: item.reconciledCommit }
      : {}),
    createdAt: item.createdAt,
    lastCheckedAt: item.lastCheckedAt,
    ...(typeof item.releasedAt === "string" ? { releasedAt: item.releasedAt } : {})
  };
}

export class WorkspaceIsolationManager {
  readonly #statePath: string;
  readonly #configuredRoot?: string;
  readonly #allowedRoots: readonly string[];
  readonly #workspaceRoots: () => readonly string[];
  readonly #records = new Map<string, IsolationRecord>();

  constructor(args: {
    statePath: string;
    isolationRoot?: string;
    allowedRoots: readonly string[];
    workspaceRoots: () => readonly string[];
  }) {
    this.#statePath = args.statePath;
    this.#allowedRoots = [...args.allowedRoots];
    this.#workspaceRoots = args.workspaceRoots;
    this.#configuredRoot = args.isolationRoot?.trim()
      ? path.resolve(args.isolationRoot.trim())
      : undefined;

    if (this.#configuredRoot) this.#validateConfiguredRoot(this.#configuredRoot);
    this.#load();
  }

  #validateConfiguredRoot(root: string): void {
    if (!path.isAbsolute(root)) {
      throw new Error("P05_ISOLATION_ROOT must be an absolute path.");
    }
    if (!this.#allowedRoots.some((allowed) => inside(root, allowed))) {
      throw new Error("P05_ISOLATION_ROOT must be inside REMOTE_AGENT_ALLOWED_ROOTS.");
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error("P05_ISOLATION_ROOT must already exist as a directory.");
    }

    const real = fs.realpathSync(root);
    if (!this.#allowedRoots.some((allowed) => inside(real, allowed))) {
      throw new Error("P05_ISOLATION_ROOT resolves outside REMOTE_AGENT_ALLOWED_ROOTS.");
    }

    for (const workspaceRoot of this.#workspaceRoots()) {
      const workspaceReal = fs.realpathSync(workspaceRoot);
      if (inside(real, workspaceReal) || inside(workspaceReal, real)) {
        throw new Error("P05_ISOLATION_ROOT must not overlap a registered workspace root.");
      }
    }
  }

  #load(): void {
    if (!fs.existsSync(this.#statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#statePath, "utf8")) as Partial<PersistedState>;
      for (const raw of parsed.isolations ?? []) {
        const record = safeRecord(raw);
        if (record) this.#records.set(record.id, record);
      }
      this.#trim();
      this.#persist();
    } catch {
      throw new Error("Workspace isolation state is invalid.");
    }
  }

  #trim(): void {
    if (this.#records.size <= MAX_RECORDS) return;
    const removable = [...this.#records.values()]
      .filter((record) => record.state !== "active")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.#records.size > MAX_RECORDS && removable.length > 0) {
      this.#records.delete(removable.shift()!.id);
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const temp = this.#statePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({
      version: 1,
      isolations: [...this.#records.values()]
    }, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.#statePath);
  }

  #rootRequired(): string {
    if (!this.#configuredRoot) {
      throw new Error(
        "Workspace isolation is not configured. Set P05_ISOLATION_ROOT to an operator-provisioned directory."
      );
    }
    return this.#configuredRoot;
  }

  #worktreePath(id: string): string {
    return path.join(this.#rootRequired(), id);
  }

  #assertOwner(context: ExecutionContext, id: string): IsolationRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error('Unknown isolation "' + id + '".');
    if (record.workspaceId !== context.workspaceId) {
      throw new Error(
        'Isolation "' + id + '" belongs to workspace "' + record.workspaceId +
        '", not workspace "' + context.workspaceId + '".'
      );
    }
    if (
      record.ownerActorType !== context.actor.type ||
      record.ownerActorId !== context.actor.id
    ) {
      throw new Error('Isolation "' + id + '" belongs to a different execution actor.');
    }
    return record;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      });
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    } catch (error: any) {
      const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(stderr || "Git isolation command failed.");
    }
  }

  async #inspectRecord(
    context: ExecutionContext,
    record: IsolationRecord
  ): Promise<IsolationView> {
    const root = record.mode === "workspace"
      ? context.workspaceRoot
      : this.#worktreePath(record.id);

    if (record.state !== "active") return { ...record, root };

    if (!fs.existsSync(root)) {
      record.state = "broken";
      record.lastCheckedAt = now();
      this.#records.set(record.id, { ...record });
      this.#persist();
      return { ...record, root };
    }

    if (record.mode === "workspace") {
      record.lastCheckedAt = now();
      this.#records.set(record.id, { ...record });
      this.#persist();
      return { ...record, root };
    }

    try {
      const currentCommit = (await this.#git(root, ["rev-parse", "HEAD"])).trim();
      const porcelain = await this.#git(root, [
        "status", "--porcelain=v1", "--untracked-files=all"
      ]);
      record.lastCheckedAt = now();
      this.#records.set(record.id, { ...record });
      this.#persist();
      return {
        ...record,
        root,
        currentCommit,
        dirty: porcelain.length > 0
      };
    } catch {
      record.state = "broken";
      record.lastCheckedAt = now();
      this.#records.set(record.id, { ...record });
      this.#persist();
      return { ...record, root };
    }
  }

  configured(): boolean {
    return Boolean(this.#configuredRoot);
  }

  async allocate(
    context: ExecutionContext,
    mode: IsolationMode
  ): Promise<IsolationAllocation> {
    const activeCount = [...this.#records.values()]
      .filter((record) =>
        record.workspaceId === context.workspaceId && record.state === "active"
      )
      .length;
    if (activeCount >= MAX_ACTIVE_PER_WORKSPACE) {
      throw new Error(
        'Too many active isolations for workspace "' + context.workspaceId +
        '" (limit ' + MAX_ACTIVE_PER_WORKSPACE + ")."
      );
    }

    const id = "iso-" + randomUUID().replaceAll("-", "").slice(0, 16);
    const createdAt = now();
    const record: IsolationRecord = {
      id,
      workspaceId: context.workspaceId,
      ownerActorType: context.actor.type,
      ownerActorId: context.actor.id,
      mode,
      state: "active",
      createdAt,
      lastCheckedAt: createdAt
    };

    let root = context.workspaceRoot;
    if (mode === "worktree") {
      const isolationRoot = this.#rootRequired();
      const sourceReal = fs.realpathSync(context.workspaceRoot);
      const topLevel = fs.realpathSync(
        (await this.#git(context.workspaceRoot, ["rev-parse", "--show-toplevel"])).trim()
      );
      if (normalize(sourceReal) !== normalize(topLevel)) {
        throw new Error(
          "Workspace root must be the Git repository top-level for worktree isolation."
        );
      }

      const baseCommit = (await this.#git(context.workspaceRoot, ["rev-parse", "HEAD"])).trim();
      root = path.join(isolationRoot, id);
      await this.#git(context.workspaceRoot, [
        "-c", "advice.detachedHead=false",
        "worktree", "add", "--detach", root, baseCommit
      ]);
      record.baseCommit = baseCommit;
    }

    this.#records.set(id, record);
    this.#trim();
    this.#persist();

    const isolatedContext = createExecutionContext({
      workspace: { id: context.workspaceId, root: context.workspaceRoot },
      actor: context.actor,
      profile: context.authority.profile,
      executionId: context.executionId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      approvalState: context.authority.approvalState,
      isolation: {
        kind: mode === "worktree" ? "worktree" : "workspace",
        root,
        sourceWorkspaceId: context.workspaceId
      }
    });

    return {
      context: isolatedContext,
      isolation: await this.#inspectRecord(isolatedContext, record)
    };
  }

  async inspect(context: ExecutionContext, id: string): Promise<IsolationView> {
    return this.#inspectRecord(context, this.#assertOwner(context, id));
  }

  async list(context: ExecutionContext): Promise<IsolationView[]> {
    const records = [...this.#records.values()]
      .filter((record) =>
        record.workspaceId === context.workspaceId &&
        record.ownerActorType === context.actor.type &&
        record.ownerActorId === context.actor.id
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const views: IsolationView[] = [];
    for (const record of records) {
      views.push(await this.#inspectRecord(context, record));
    }
    return views;
  }

  async prepareReconcile(
    context: ExecutionContext,
    id: string
  ): Promise<ReconcilePlan> {
    const record = this.#assertOwner(context, id);
    if (record.mode !== "worktree" || !record.baseCommit) {
      throw new Error("Reconciliation is only defined for worktree isolation.");
    }
    const view = await this.#inspectRecord(context, record);
    if (view.state !== "active" || !view.currentCommit) {
      throw new Error('Isolation "' + id + '" is not an inspectable active worktree.');
    }

    const commitsRaw = await this.#git(view.root, [
      "rev-list", "--reverse", record.baseCommit + ".." + view.currentCommit
    ]);
    const commits = commitsRaw ? commitsRaw.split(/\r?\n/).filter(Boolean) : [];
    return {
      isolationId: id,
      workspaceId: record.workspaceId,
      baseCommit: record.baseCommit,
      currentCommit: view.currentCommit,
      commits,
      dirty: view.dirty ?? false,
      ready: !(view.dirty ?? false)
    };
  }

  async acknowledgeReconciled(
    context: ExecutionContext,
    id: string,
    sourceCommit: string
  ): Promise<IsolationView> {
    const record = this.#assertOwner(context, id);
    if (record.mode !== "worktree") {
      throw new Error("Only worktree isolation requires reconciliation acknowledgement.");
    }
    const view = await this.#inspectRecord(context, record);
    if (view.state !== "active" || !view.currentCommit) {
      throw new Error('Isolation "' + id + '" is not active.');
    }
    if (view.dirty) {
      throw new Error('Isolation "' + id + '" has uncommitted changes.');
    }
    if (view.currentCommit !== sourceCommit) {
      throw new Error("Reconcile acknowledgement does not match the current source commit.");
    }

    record.reconciledCommit = sourceCommit;
    record.lastCheckedAt = now();
    this.#records.set(id, { ...record });
    this.#persist();
    return this.#inspectRecord(context, record);
  }

  async release(context: ExecutionContext, id: string): Promise<IsolationView> {
    const record = this.#assertOwner(context, id);
    if (record.state !== "active") return this.#inspectRecord(context, record);

    if (record.mode === "worktree") {
      const view = await this.#inspectRecord(context, record);
      if (view.state !== "active" || !view.currentCommit) return view;
      if (view.dirty) {
        throw new Error('Isolation "' + id + '" has uncommitted changes; refusing release.');
      }
      if (
        record.baseCommit &&
        view.currentCommit !== record.baseCommit &&
        record.reconciledCommit !== view.currentCommit
      ) {
        throw new Error(
          'Isolation "' + id + '" contains unreconciled commits; refusing release.'
        );
      }

      await this.#git(context.workspaceRoot, [
        "worktree", "remove", this.#worktreePath(id)
      ]);
    }

    const changed = now();
    record.state = "released";
    record.releasedAt = changed;
    record.lastCheckedAt = changed;
    this.#records.set(id, { ...record });
    this.#persist();
    return this.#inspectRecord(context, record);
  }
}
