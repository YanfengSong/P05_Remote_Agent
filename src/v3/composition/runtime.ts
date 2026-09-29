import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CompositionEvents, immutableSnapshot, type InterceptorEnvelope, type InterceptorResult } from "./events.js";
import { componentManifestSchema, CompositionError, keyId, type ComponentManifest, type CompositionScope, type ExternalEffectRecord, type FiberState, type ServiceKey } from "./contracts.js";

export interface ComponentContext {
  readonly scope: Readonly<CompositionScope>;
  readonly fiberId: string;
  require<T>(key: ServiceKey<T>): T;
  registry<T>(key: ServiceKey<T>): readonly T[];
  provide<T>(key: ServiceKey<T>, value: T): void;
  onDispose(disposer: () => void | Promise<void>): void;
  interval(callback: () => void | Promise<void>, milliseconds: number): void;
  observe(topic: string, callback: (snapshot: Readonly<unknown>) => void | Promise<void>): void;
  intercept(point: string, priority: number, callback: (input: Readonly<InterceptorEnvelope>) => InterceptorResult | Promise<InterceptorResult>): void;
  external(effect: "E2" | "E3" | "E4", manager: string, reference: string, input: unknown): Promise<unknown>;
}
export interface ComponentDefinition<C = unknown> {
  manifest: ComponentManifest;
  configSchema: z.ZodType<C>;
  activate(context: ComponentContext, config: Readonly<C>): void | Promise<void>;
}
interface Entry {
  key: string; scopeId: string; definition: ComponentDefinition; config: unknown;
  desired: { enabled: boolean; manualHold: boolean; revision: number };
  appliedRevision: number | null; current?: Fiber; failedRevision?: number;
  observed: FiberState; diagnostic: string | null;
}
interface Fiber {
  id: string; entry: Entry; definition: ComponentDefinition; state: FiberState;
  values: Map<string, unknown[]>; requirements: Map<string, unknown[]>;
  dependencies: Set<Fiber>; disposers: (() => void | Promise<void>)[]; pins: number;
  externalEffects: ExternalEffectRecord[]; done: Promise<void>; finish: () => void;
}
export interface ServicePin<T> { value: T; bindingId: string; release(): void }
export interface CompositionDesiredStore { get<T>(key: string): T | undefined; put(key: string, value: unknown): void }
const savedDesiredSchema = z.object({ revision: z.string(), entrypointDigest: z.string(), configVersion: z.string(), config: z.unknown(), desired: z.object({ enabled: z.boolean(), manualHold: z.boolean(), revision: z.number().int().positive() }).strict() }).strict();

/** Trusted installed-code composition only. Scope and Shadow are not code/OS sandboxes. */
export class CompositionRuntime {
  readonly events: CompositionEvents;
  private readonly scopes = new Map<string, CompositionScope>();
  private readonly entries = new Map<string, Entry>();
  private readonly fibers = new Map<string, Fiber>();
  private busy = false;
  constructor(private readonly options: {
    platform?: NodeJS.Platform;
    events?: CompositionEvents;
    desiredStore?: CompositionDesiredStore;
    executeExternal?: (request: { componentId: string; fiberId: string; scope: CompositionScope; effect: "E2" | "E3" | "E4"; manager: string; reference: string; input: unknown }) => Promise<unknown>;
  } = {}) { this.events = options.events ?? new CompositionEvents(); }

  createScope(scope: CompositionScope): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(scope.id) || this.scopes.has(scope.id) || !["platform", "workspace", "agent", "run", "shadow"].includes(scope.kind)) throw new CompositionError("INVALID_SCOPE");
    if (scope.kind === "platform" ? scope.parentId !== undefined : !scope.parentId || !this.scopes.has(scope.parentId)) throw new CompositionError("INVALID_SCOPE_PARENT");
    this.scopes.set(scope.id, Object.freeze({ ...scope }));
  }

  private scope(id: string): CompositionScope { const scope = this.scopes.get(id); if (!scope) throw new CompositionError("UNKNOWN_SCOPE"); return scope; }
  private ancestors(id: string): string[] { const result: string[] = []; let scope: CompositionScope | undefined = this.scope(id); while (scope) { result.push(scope.id); scope = scope.parentId ? this.scope(scope.parentId) : undefined; } return result; }
  private assertIdle(): void { if (this.busy) throw new CompositionError("COMPOSITION_OPERATION_IN_PROGRESS"); }
  private entry(scopeId: string, componentId: string): Entry { const entry = this.entries.get(`${scopeId}/${componentId}`); if (!entry) throw new CompositionError("UNKNOWN_COMPONENT"); return entry; }

  private parsed<C>(definition: ComponentDefinition<C>, scopeId: string): ComponentDefinition {
    const manifest = componentManifestSchema.parse(definition.manifest);
    if (manifest.scope !== this.scope(scopeId).kind) throw new CompositionError("COMPONENT_SCOPE_MISMATCH");
    for (const contributions of [manifest.provides, manifest.requires]) if (new Set(contributions.map((item) => keyId(item.key))).size !== contributions.length) throw new CompositionError("DUPLICATE_SERVICE_DECLARATION");
    return { ...definition, manifest: immutableSnapshot(manifest) as ComponentManifest } as ComponentDefinition;
  }

  register<C>(scopeId: string, definition: ComponentDefinition<C>, config: C): void {
    this.assertIdle();
    const parsed = this.parsed(definition, scopeId);
    const key = `${scopeId}/${parsed.manifest.componentId}`;
    if (this.entries.has(key)) throw new CompositionError("DUPLICATE_COMPONENT");
    const entry: Entry = { key, scopeId, definition: parsed, config: immutableSnapshot(parsed.configSchema.parse(config)), desired: { enabled: true, manualHold: false, revision: 1 }, appliedRevision: null, observed: "PENDING", diagnostic: null };
    const stored = this.options.desiredStore?.get<unknown>(`service:composition:${key}`);
    if (stored !== undefined) {
      const saved = savedDesiredSchema.parse(stored);
      if (saved.revision !== parsed.manifest.revision || saved.entrypointDigest !== parsed.manifest.entrypointDigest || saved.configVersion !== parsed.manifest.configVersion) throw new CompositionError("COMPONENT_PERSISTED_DEFINITION_MISMATCH");
      entry.config = immutableSnapshot(parsed.configSchema.parse(saved.config)); entry.desired = saved.desired;
    }
    this.entries.set(key, entry);
    try { this.validateGraph(); this.persistDesired(entry, entry.definition, entry.config, entry.desired); } catch (error) { this.entries.delete(key); throw error; }
  }

  private persistDesired(entry: Entry, definition: ComponentDefinition, config: unknown, desired: Entry["desired"]): void {
    this.options.desiredStore?.put(`service:composition:${entry.key}`, { revision: definition.manifest.revision, entrypointDigest: definition.manifest.entrypointDigest, configVersion: definition.manifest.configVersion, config, desired });
  }

  private visibleEntries(scopeId: string, key: ServiceKey, kind: "single" | "registry"): Entry[] {
    for (const realm of this.ancestors(scopeId)) {
      const entries = [...this.entries.values()].filter((entry) => entry.scopeId === realm && entry.definition.manifest.provides.some((provided) => keyId(provided.key) === keyId(key)));
      if (entries.length) return entries.filter((entry) => entry.definition.manifest.provides.some((provided) => keyId(provided.key) === keyId(key) && provided.kind === kind));
    }
    return [];
  }

  private validateGraph(): void {
    const contributions = new Map<string, { kind: string; entries: Entry[] }>();
    for (const entry of this.entries.values()) for (const provided of entry.definition.manifest.provides) {
      const key = `${entry.scopeId}/${keyId(provided.key)}`;
      const prior = contributions.get(key);
      if (prior && (provided.kind === "single" || prior.kind !== provided.kind)) throw new CompositionError("DUPLICATE_SERVICE_PROVIDER");
      contributions.set(key, { kind: provided.kind, entries: [...prior?.entries ?? [], entry] });
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (entry: Entry): void => {
      if (visiting.has(entry.key)) throw new CompositionError("COMPONENT_DEPENDENCY_CYCLE", `Dependency cycle includes ${entry.key}`);
      if (visited.has(entry.key)) return;
      visiting.add(entry.key);
      for (const required of entry.definition.manifest.requires) for (const provider of this.visibleEntries(entry.scopeId, required.key, required.kind)) visit(provider);
      visiting.delete(entry.key); visited.add(entry.key);
    };
    for (const entry of this.entries.values()) visit(entry);
  }

  private providers(scopeId: string, key: ServiceKey, kind: "single" | "registry"): Fiber[] {
    // A declared local provider shadows its ancestor even when pending/failed.
    return this.visibleEntries(scopeId, key, kind).map((entry) => entry.current).filter((fiber): fiber is Fiber => !!fiber && fiber.state === "ACTIVE");
  }

  pin<T>(scopeId: string, key: ServiceKey<T>): ServicePin<T> {
    const providers = this.providers(scopeId, key, "single");
    if (providers.length !== 1) throw new CompositionError("SERVICE_UNAVAILABLE");
    const fiber = providers[0]; fiber.pins++;
    let released = false;
    return { value: fiber.values.get(keyId(key))![0] as T, bindingId: fiber.id, release: () => { if (!released) { released = true; fiber.pins--; this.maybeDispose(fiber); } } };
  }

  pinRegistry<T>(scopeId: string, key: ServiceKey<T>): { values: readonly T[]; bindingIds: string[]; release(): void } {
    const providers = this.providers(scopeId, key, "registry");
    if (!providers.length) throw new CompositionError("SERVICE_UNAVAILABLE");
    providers.forEach((fiber) => fiber.pins++);
    let released = false;
    return { values: Object.freeze(providers.flatMap((fiber) => fiber.values.get(keyId(key))!) as T[]), bindingIds: providers.map((fiber) => fiber.id), release: () => { if (!released) { released = true; providers.forEach((fiber) => { fiber.pins--; this.maybeDispose(fiber); }); } } };
  }

  setDesired(scopeId: string, componentId: string, desired: { enabled: boolean; manualHold: boolean }, expectedRevision: number): number {
    this.assertIdle(); const entry = this.entry(scopeId, componentId);
    if (entry.desired.revision !== expectedRevision) throw new CompositionError("STALE_COMPONENT_REVISION");
    if (typeof desired.enabled !== "boolean" || typeof desired.manualHold !== "boolean") throw new CompositionError("INVALID_COMPONENT_DESIRED");
    const next = { ...desired, revision: expectedRevision + 1 };
    this.persistDesired(entry, entry.definition, entry.config, next); entry.desired = next;
    return entry.desired.revision;
  }

  async reconcile(): Promise<void> {
    this.assertIdle(); this.busy = true;
    try { await this.reconcileInternal(); } finally { this.busy = false; }
  }

  private async reconcileInternal(): Promise<void> {
    for (const entry of this.entries.values()) if ((!entry.desired.enabled || entry.desired.manualHold) && entry.current) this.retire(entry.current);
    let progress = true;
    while (progress) {
      progress = false;
      for (const entry of this.entries.values()) {
        if (entry.current || !entry.desired.enabled || entry.desired.manualHold || entry.failedRevision === entry.desired.revision) continue;
        if (entry.definition.manifest.requires.some((required) => this.providers(entry.scopeId, required.key, required.kind).length === 0)) { entry.observed = "PENDING"; entry.diagnostic = "MISSING_DEPENDENCY"; continue; }
        try {
          const fiber = await this.activate(entry, entry.definition, entry.config);
          fiber.state = "ACTIVE"; entry.current = fiber; entry.observed = "ACTIVE"; entry.appliedRevision = entry.desired.revision; entry.diagnostic = null;
        } catch { entry.observed = "FAILED"; entry.failedRevision = entry.desired.revision; entry.diagnostic = "ACTIVATION_FAILED"; }
        progress = true;
      }
    }
  }

  private async activate(entry: Entry, definition: ComponentDefinition, config: unknown): Promise<Fiber> {
    if (!definition.manifest.hostCompatibility.includes((this.options.platform ?? process.platform) as "win32" | "linux" | "darwin")) throw new CompositionError("INCOMPATIBLE_HOST");
    let finish!: () => void;
    const fiber: Fiber = { id: randomUUID(), entry, definition, state: "ACTIVATING", values: new Map(), requirements: new Map(), dependencies: new Set(), disposers: [], pins: 0, externalEffects: [], done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    this.fibers.set(fiber.id, fiber);
    const assertLive = () => { if (!["ACTIVATING", "ACTIVE"].includes(fiber.state)) throw new CompositionError("FIBER_RETIRED"); };
    const own = (disposer: () => void | Promise<void>) => {
      assertLive();
      if (!definition.manifest.effectOwnership.some((effect) => effect.effect === "E1")) throw new CompositionError("UNDECLARED_E1_EFFECT");
      let disposed = false;
      fiber.disposers.push(async () => { if (!disposed) { disposed = true; await disposer(); } });
    };
    try {
      for (const requirement of definition.manifest.requires) {
        const providers = this.providers(entry.scopeId, requirement.key, requirement.kind);
        if (!providers.length) throw new CompositionError("MISSING_DEPENDENCY");
        fiber.requirements.set(keyId(requirement.key), providers.flatMap((provider) => provider.values.get(keyId(requirement.key))!));
        for (const provider of providers) if (!fiber.dependencies.has(provider)) {
          fiber.dependencies.add(provider); provider.pins++;
          fiber.disposers.push(() => { provider.pins--; this.maybeDispose(provider); });
        }
      }
      const context: ComponentContext = {
        scope: this.scope(entry.scopeId), fiberId: fiber.id,
        require: <T>(key: ServiceKey<T>) => { assertLive(); if (!definition.manifest.requires.some((requirement) => keyId(requirement.key) === keyId(key) && requirement.kind === "single")) throw new CompositionError("UNDECLARED_DEPENDENCY"); return fiber.requirements.get(keyId(key))![0] as T; },
        registry: <T>(key: ServiceKey<T>) => { assertLive(); if (!definition.manifest.requires.some((requirement) => keyId(requirement.key) === keyId(key) && requirement.kind === "registry")) throw new CompositionError("UNDECLARED_DEPENDENCY"); return Object.freeze([...fiber.requirements.get(keyId(key))!]) as T[]; },
        provide: <T>(key: ServiceKey<T>, value: T) => {
          if (fiber.state !== "ACTIVATING") throw new CompositionError("SERVICE_PUBLICATION_CLOSED"); const declaration = definition.manifest.provides.find((provided) => keyId(provided.key) === keyId(key));
          if (!declaration) throw new CompositionError("UNDECLARED_SERVICE");
          const values = fiber.values.get(keyId(key)) ?? [];
          if (declaration.kind === "single" && values.length) throw new CompositionError("DUPLICATE_SERVICE_PROVIDER");
          values.push(value); fiber.values.set(keyId(key), values);
        },
        onDispose: own,
        interval: (callback, milliseconds) => {
          if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 86_400_000) throw new CompositionError("INVALID_INTERVAL");
          let timer: ReturnType<typeof setInterval> | undefined;
          own(() => { if (timer) clearInterval(timer); });
          let running = false;
          timer = setInterval(() => {
            if (running || fiber.state !== "ACTIVE") return;
            running = true; fiber.pins++;
            Promise.resolve().then(callback).catch(() => this.failFiber(fiber)).finally(() => { running = false; fiber.pins--; this.maybeDispose(fiber); });
          }, milliseconds);
        },
        observe: (topic, callback) => { let dispose = () => undefined as void; own(() => dispose()); dispose = this.events.subscribe(topic, async (event) => { if (fiber.state !== "ACTIVE") return; fiber.pins++; try { await callback(event); } finally { fiber.pins--; this.maybeDispose(fiber); } }, () => this.failFiber(fiber)); },
        intercept: (point, priority, callback) => { let dispose = () => undefined as void; own(() => dispose()); dispose = this.events.intercept(point, priority, async (input) => { if (fiber.state !== "ACTIVE") return {}; fiber.pins++; try { return await callback(input); } finally { fiber.pins--; this.maybeDispose(fiber); } }); },
        external: async (effect, manager, reference, input) => {
          assertLive();
          if (this.ancestors(entry.scopeId).some((id) => this.scope(id).kind === "shadow")) throw new CompositionError("SHADOW_EXTERNAL_EFFECT_DENIED");
          if (!definition.manifest.effectOwnership.some((owned) => owned.effect === effect && owned.management === "external" && owned.manager === manager)) throw new CompositionError("UNDECLARED_EXTERNAL_EFFECT");
          if (!this.options.executeExternal) throw new CompositionError("EXTERNAL_EFFECT_MANAGER_UNAVAILABLE");
          const record: ExternalEffectRecord = { effect, manager, reference, state: "requested" }; fiber.externalEffects.push(record);
          try { const result = await this.options.executeExternal({ componentId: definition.manifest.componentId, fiberId: fiber.id, scope: this.scope(entry.scopeId), effect, manager, reference, input: structuredClone(input) }); record.state = "applied"; return result; }
          catch (error) { record.state = "unknown"; throw error; }
        },
      };
      await definition.activate(context, config as Readonly<unknown>);
      for (const contribution of definition.manifest.provides) if (!fiber.values.get(keyId(contribution.key))?.length) throw new CompositionError("MISSING_DECLARED_SERVICE");
      if (fiber.state !== "ACTIVATING" || [...fiber.dependencies].some((dependency) => dependency.state !== "ACTIVE")) throw new CompositionError("ACTIVATION_DEPENDENCY_RETIRED");
      return fiber;
    } catch (error) { this.retire(fiber); await this.waitForDrain(fiber.id, 5_000); throw error; }
  }

  private failFiber(fiber: Fiber): void {
    if (!["ACTIVATING", "ACTIVE"].includes(fiber.state)) return;
    fiber.entry.failedRevision = fiber.entry.desired.revision; fiber.entry.diagnostic = "OWNED_CALLBACK_FAILED";
    this.retire(fiber);
  }

  private retire(fiber: Fiber): void {
    if (["DRAINING", "DISPOSING", "DISPOSED", "FAILED"].includes(fiber.state)) return;
    fiber.state = "DRAINING";
    if (fiber.entry.current === fiber) { fiber.entry.current = undefined; fiber.entry.observed = "DRAINING"; }
    for (const dependent of this.fibers.values()) if (dependent.dependencies.has(fiber)) this.retire(dependent);
    this.maybeDispose(fiber);
  }

  private maybeDispose(fiber: Fiber): void {
    if (fiber.state !== "DRAINING" || fiber.pins !== 0) return;
    fiber.state = "DISPOSING";
    void (async () => {
      let failed = false;
      for (const dispose of [...fiber.disposers].reverse()) { try { await dispose(); } catch { failed = true; } }
      fiber.state = failed ? "FAILED" : "DISPOSED";
      if (!fiber.entry.current && fiber.entry.observed === "DRAINING") fiber.entry.observed = fiber.state;
      fiber.finish();
    })();
  }

  async replace<C>(scopeId: string, componentId: string, definition: ComponentDefinition<C>, config: C, expectedRevision: number) {
    this.assertIdle(); const entry = this.entry(scopeId, componentId); this.busy = true;
    const previousDefinition = entry.definition;
    try {
      if (entry.desired.revision !== expectedRevision) throw new CompositionError("STALE_COMPONENT_REVISION");
      if (!entry.desired.enabled || entry.desired.manualHold) throw new CompositionError("COMPONENT_NOT_DESIRED");
      const parsed = this.parsed(definition, scopeId);
      if (parsed.manifest.componentId !== componentId) throw new CompositionError("COMPONENT_ID_CHANGED");
      const parsedConfig = immutableSnapshot(parsed.configSchema.parse(config));
      entry.definition = parsed;
      try { this.validateGraph(); } finally { entry.definition = previousDefinition; }
      const candidate = await this.activate(entry, parsed, parsedConfig);
      const previous = entry.current;
      try { this.persistDesired(entry, parsed, parsedConfig, { ...entry.desired, revision: entry.desired.revision + 1 }); }
      catch (error) { this.retire(candidate); await this.waitForDrain(candidate.id); throw error; }
      candidate.state = "ACTIVE"; entry.definition = parsed; entry.config = parsedConfig; entry.current = candidate;
      entry.desired.revision++; entry.appliedRevision = entry.desired.revision; entry.observed = "ACTIVE"; entry.diagnostic = null;
      if (previous) this.retire(previous);
      await this.reconcileInternal();
      return { bindingId: candidate.id, previousBindingId: previous?.id, appliedRevision: entry.appliedRevision };
    } catch (error) { entry.diagnostic = "CANDIDATE_NOT_APPLIED_EXTERNAL_EFFECTS_NOT_ROLLED_BACK"; throw error; }
    finally { this.busy = false; }
  }

  async waitForDrain(bindingId: string, timeoutMs = 5_000): Promise<boolean> {
    const fiber = this.fibers.get(bindingId);
    if (!fiber) throw new CompositionError("UNKNOWN_FIBER");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) throw new CompositionError("INVALID_DRAIN_TIMEOUT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([fiber.done.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  status(scopeId: string, componentId: string) {
    const entry = this.entry(scopeId, componentId);
    return { componentId, scopeId, revision: entry.definition.manifest.revision, desired: { ...entry.desired }, appliedRevision: entry.appliedRevision, observed: entry.observed, diagnostic: entry.diagnostic,
      fibers: [...this.fibers.values()].filter((fiber) => fiber.entry === entry).map((fiber) => ({ bindingId: fiber.id, revision: fiber.definition.manifest.revision, state: fiber.state, pins: fiber.pins, externalEffects: structuredClone(fiber.externalEffects), externalEffectsAutomaticallyRolledBack: false })),
      desiredPersistence: this.options.desiredStore ? "host-store" : "memory", isolationEnforced: false };
  }

  async close(timeoutMs = 5_000): Promise<boolean> {
    this.assertIdle();
    for (const entry of this.entries.values()) { entry.desired.manualHold = true; if (entry.current) this.retire(entry.current); }
    return (await Promise.all([...this.fibers.values()].map((fiber) => this.waitForDrain(fiber.id, timeoutMs)))).every(Boolean);
  }
}
