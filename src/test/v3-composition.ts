import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AssetStore, CompositionEvents, CompositionRuntime, createServiceKey, type ComponentContext, type ComponentDefinition, type ComponentManifest } from "../v3/composition/index.js";
import { CoreState } from "../v3/core/index.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "p05-v3-composition-"));
const runtimes: CompositionRuntime[] = [];
const stores: AssetStore[] = [];
const coreStores: CoreState[] = [];
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const service = createServiceKey<{ value: string }>("example.service", "1");
const derived = createServiceKey<string>("example.derived", "1");
const registry = createServiceKey<string>("example.registry", "1");
const schema = z.object({ label: z.string() }).strict();
function manifest(componentId: string, overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return { componentId, revision: "1", entrypointDigest: "a".repeat(64), configVersion: "1", scope: "platform", hostCompatibility: ["win32", "linux", "darwin"], provides: [], requires: [], effectOwnership: [{ effect: "E1", management: "fiber" }], activationPolicy: "desired", ...overrides };
}
function definition(componentId: string, activate: (ctx: ComponentContext, config: Readonly<{ label: string }>) => void | Promise<void>, overrides: Partial<ComponentManifest> = {}): ComponentDefinition<{ label: string }> {
  return { manifest: manifest(componentId, overrides), configSchema: schema, activate };
}
function runtime(options: ConstructorParameters<typeof CompositionRuntime>[0] = {}) {
  const value = new CompositionRuntime(options); value.createScope({ id: "platform", kind: "platform" }); runtimes.push(value); return value;
}

try {
  const engine = runtime();
  engine.register("platform", definition("consumer", (ctx) => ctx.provide(derived, ctx.require(service).value), { provides: [{ key: derived, kind: "single" }], requires: [{ key: service, kind: "single" }] }), { label: "consumer" });
  await engine.reconcile();
  check(engine.status("platform", "consumer").observed === "PENDING", "missing dependency leaves component pending");
  engine.register("platform", definition("provider", (ctx, config) => ctx.provide(service, { value: config.label }), { provides: [{ key: service, kind: "single" }] }), { label: "original" });
  await engine.reconcile();
  const consumer = engine.pin("platform", derived);
  check(consumer.value === "original", "topological activation passes declared typed service"); consumer.release();
  assert.throws(() => engine.register("platform", definition("duplicate", (ctx) => ctx.provide(service, { value: "bad" }), { provides: [{ key: service, kind: "single" }] }), { label: "duplicate" }), /DUPLICATE_SERVICE_PROVIDER/); checks++;
  engine.createScope({ id: "workspace", kind: "workspace", parentId: "platform" });
  const inherited = engine.pin("workspace", service); check(inherited.value.value === "original", "workspace inherits visible platform service"); inherited.release();
  engine.register("workspace", definition("local", (ctx) => ctx.provide(service, { value: "local" }), { scope: "workspace", provides: [{ key: service, kind: "single" }] }), { label: "local" });
  await engine.reconcile();
  const local = engine.pin("workspace", service); const platform = engine.pin("platform", service);
  check(local.value.value === "local" && platform.value.value === "original", "workspace override does not overwrite platform provider"); local.release(); platform.release();

  engine.register("platform", definition("registry-a", (ctx) => ctx.provide(registry, "a"), { provides: [{ key: registry, kind: "registry" }] }), { label: "a" });
  engine.register("platform", definition("registry-b", (ctx) => ctx.provide(registry, "b"), { provides: [{ key: registry, kind: "registry" }] }), { label: "b" });
  await engine.reconcile();
  const contributors = engine.pinRegistry("platform", registry);
  check(contributors.values.join(",") === "a,b", "registry explicitly supports multiple contributions"); contributors.release();
  assert.throws(() => engine.pin("platform", registry), /SERVICE_UNAVAILABLE/); checks++;

  const x = createServiceKey<string>("cycle.x", "1"); const y = createServiceKey<string>("cycle.y", "1");
  engine.register("platform", definition("cycle-x", () => undefined, { provides: [{ key: x, kind: "single" }], requires: [{ key: y, kind: "single" }] }), { label: "x" });
  assert.throws(() => engine.register("platform", definition("cycle-y", () => undefined, { provides: [{ key: y, kind: "single" }], requires: [{ key: x, kind: "single" }] }), { label: "y" }), /Dependency cycle/); checks++;
  engine.register("platform", definition("bad", () => { throw new Error("private failure"); }), { label: "bad" });
  await engine.reconcile();
  check(engine.status("platform", "bad").observed === "FAILED" && engine.status("platform", "provider").observed === "ACTIVE", "activation failure stays local");
  check(!JSON.stringify(engine.status("platform", "bad")).includes("private failure"), "diagnostics hide raw activation exceptions");

  engine.setDesired("platform", "provider", { enabled: true, manualHold: true }, 1);
  await engine.reconcile();
  assert.throws(() => engine.pin("platform", service), /SERVICE_UNAVAILABLE/); checks++;
  assert.throws(() => engine.pin("platform", derived), /SERVICE_UNAVAILABLE/); checks++;
  await engine.reconcile();
  check(engine.status("platform", "provider").desired.manualHold && engine.status("platform", "consumer").observed === "PENDING", "manual hold and dependency loss prevent automatic restart");
  engine.setDesired("platform", "provider", { enabled: true, manualHold: false }, 2);
  await engine.reconcile();
  const rebuilt = engine.pin("platform", derived); check(rebuilt.value === "original", "resumed provider reconstructs dependent fiber"); rebuilt.release();
  await assert.rejects(engine.replace("platform", "provider", definition("provider", () => undefined), { label: "bad" }, 1), /STALE_COMPONENT_REVISION/); checks++;

  let externalChanges = 0;
  const effects = runtime({ executeExternal: async () => { externalChanges++; return { reference: "external-result" }; } });
  const cleanup: string[] = [];
  let ticks = 0; let eventsSeen = 0;
  const ownedDefinition = (revision: string) => definition("owned", (ctx, config) => {
    ctx.onDispose(() => { cleanup.push(`${revision}:first`); });
    ctx.onDispose(() => { cleanup.push(`${revision}:second`); });
    ctx.interval(() => { ticks++; }, 5);
    ctx.observe("notice", (snapshot) => { check(Object.isFrozen(snapshot), "observer receives immutable snapshot"); eventsSeen++; });
    ctx.provide(service, { value: config.label });
  }, { revision, provides: [{ key: service, kind: "single" }] });
  effects.register("platform", ownedDefinition("1"), { label: "old" });
  await effects.reconcile(); await delay(25);
  check(ticks > 0, "real owned timer is active");
  await effects.events.emit("notice", { nested: { value: 1 } });
  const old = effects.pin("platform", service);
  const replacement = await effects.replace("platform", "owned", ownedDefinition("2"), { label: "new" }, 1);
  const fresh = effects.pin("platform", service);
  check(old.value.value === "old" && fresh.value.value === "new" && fresh.bindingId !== old.bindingId, "atomic binding replacement preserves old in-flight provider");
  check(!await effects.waitForDrain(old.bindingId, 5) && cleanup.length === 0, "old disposer waits for in-flight pin");
  old.release(); old.release();
  check(await effects.waitForDrain(old.bindingId), "old provider drains when final pin releases");
  check(cleanup.slice(0, 2).join(",") === "1:second,1:first", "E1 cleanup runs reverse order exactly once");
  fresh.release();
  const failCandidate = definition("owned", async (ctx) => {
    ctx.onDispose(() => { cleanup.push("candidate:e1"); });
    await ctx.external("E3", "run-manager", "test-side-effect", { operation: "test" });
    throw new Error("candidate failed after external operation");
  }, { revision: "3", provides: [{ key: service, kind: "single" }], effectOwnership: [{ effect: "E1", management: "fiber" }, { effect: "E3", management: "external", manager: "run-manager" }] });
  await assert.rejects(effects.replace("platform", "owned", failCandidate, { label: "candidate" }, 2)); checks++;
  const retained = effects.pin("platform", service);
  check(retained.value.value === "new" && effects.status("platform", "owned").appliedRevision === 2, "failed candidate retains previous provider and applied revision"); retained.release();
  check(externalChanges === 1 && cleanup.includes("candidate:e1") && effects.status("platform", "owned").fibers.some((fiber) => fiber.externalEffects.some((effect) => effect.state === "applied") && !fiber.externalEffectsAutomaticallyRolledBack), "candidate rollback cleans E1 but reports external effects unchanged");
  await assert.rejects(effects.replace("platform", "owned", ownedDefinition("4"), { label: 42 } as unknown as { label: string }, 2)); checks++;
  check(effects.status("platform", "owned").appliedRevision === 2, "invalid config cannot become applied");
  effects.setDesired("platform", "owned", { enabled: true, manualHold: true }, 2); await effects.reconcile();
  check(await effects.waitForDrain(replacement.bindingId), "current generation cleanup completes after manual stop");
  const stoppedTicks = ticks; const stoppedEvents = eventsSeen;
  await delay(25); await effects.events.emit("notice", { after: "stop" });
  check(ticks === stoppedTicks && eventsSeen === stoppedEvents, "owned timer and listener are actually removed");
  check(cleanup.filter((value) => value === "2:first").length === 1, "current E1 disposer ran once");

  effects.createScope({ id: "shadow", kind: "shadow", parentId: "platform" });
  effects.createScope({ id: "shadow-run", kind: "run", parentId: "shadow" });
  effects.register("shadow-run", definition("shadow-effect", async (ctx) => { await ctx.external("E2", "resource-manager", "would-launch", {}); }, { scope: "run", effectOwnership: [{ effect: "E2", management: "external", manager: "resource-manager" }] }), { label: "shadow" });
  await effects.reconcile();
  check(externalChanges === 1 && effects.status("shadow-run", "shadow-effect").observed === "FAILED", "Shadow denies real external effects in descendant scopes");
  check(!effects.status("shadow-run", "shadow-effect").isolationEnforced, "Shadow never claims OS sandbox");

  const hooks = new CompositionEvents(new Set(["before-submit"]), 20);
  const capture = { actorId: "actor-a", authorityDigest: "authority-a", approvalDigest: "approval-a", payload: { nested: 1 } };
  const observeInput = { nested: { value: 1 } };
  let observerFailed = false;
  hooks.subscribe("test", (input) => { (input as { nested: { value: number } }).nested.value = 2; }, () => { observerFailed = true; });
  await hooks.emit("test", observeInput);
  check(observerFailed && observeInput.nested.value === 1, "observer cannot mutate publisher data");
  hooks.intercept("before-submit", 1, () => ({ deny: true, metadata: { reason: "tightened" } }));
  hooks.intercept("before-submit", 2, () => ({ deny: false }));
  const controlled = await hooks.apply("before-submit", capture);
  check(controlled.denied && controlled.envelope.actorId === "actor-a", "later interceptor cannot undo earlier denial or change authority");
  hooks.intercept("before-submit", 3, () => ({ actorId: "attacker" } as unknown as { deny: boolean }));
  await assert.rejects(hooks.apply("before-submit", capture)); checks++;
  assert.throws(() => hooks.intercept("arbitrary-policy", 0, () => ({})), /UNKNOWN_EXTENSION_POINT/); checks++;
  const timeoutHooks = new CompositionEvents(new Set(["bounded"]), 5);
  timeoutHooks.intercept("bounded", 0, async () => new Promise(() => undefined));
  await assert.rejects(timeoutHooks.apply("bounded", capture), /HOOK_TIMEOUT/); checks++;

  const hookRuntime = runtime({ events: new CompositionEvents(new Set(["route"])) });
  const hookDefinition = (revision: string) => definition("hook-owner", (ctx) => {
    ctx.provide(service, { value: revision }); ctx.intercept("route", 1, () => ({ metadata: { revision } }));
  }, { revision, provides: [{ key: service, kind: "single" }] });
  hookRuntime.register("platform", hookDefinition("1"), { label: "hook" }); await hookRuntime.reconcile();
  const heldHook = hookRuntime.pin("platform", service);
  await hookRuntime.replace("platform", "hook-owner", hookDefinition("2"), { label: "hook" }, 1);
  check((await hookRuntime.events.apply("route", capture)).metadata.revision === "2", "retired in-flight hook cannot interfere with new generation requests");
  heldHook.release();

  const timerRuntime = runtime();
  let releaseTimer!: () => void; let timerEntered!: () => void;
  const timerRelease = new Promise<void>((resolve) => { releaseTimer = resolve; });
  const timerEntry = new Promise<void>((resolve) => { timerEntered = resolve; });
  timerRuntime.register("platform", definition("async-timer", (ctx) => { ctx.interval(async () => { timerEntered(); await timerRelease; }, 1); ctx.provide(service, { value: "timer" }); }, { provides: [{ key: service, kind: "single" }] }), { label: "timer" });
  await timerRuntime.reconcile(); await timerEntry;
  const timerBinding = timerRuntime.pin("platform", service); timerBinding.release();
  timerRuntime.setDesired("platform", "async-timer", { enabled: false, manualHold: true }, 1); await timerRuntime.reconcile();
  check(!await timerRuntime.waitForDrain(timerBinding.bindingId, 5), "async owned callback keeps fiber pinned through drain");
  releaseTimer(); check(await timerRuntime.waitForDrain(timerBinding.bindingId), "async callback completion releases drain pin");

  const stateDirectory = path.join(directory, "core-state");
  let persistentState = CoreState.open({ stateDir: stateDirectory, slotId: "A", workspaceRoots: [] }); coreStores.push(persistentState);
  const persistent = runtime({ desiredStore: persistentState });
  const persistedDefinition = definition("persisted", (ctx, config) => ctx.provide(service, { value: config.label }), { provides: [{ key: service, kind: "single" }] });
  persistent.register("platform", persistedDefinition, { label: "persisted-config" }); await persistent.reconcile();
  persistent.setDesired("platform", "persisted", { enabled: true, manualHold: true }, 1); await persistent.reconcile();
  await persistent.close(); persistentState.close();
  persistentState = CoreState.open({ stateDir: stateDirectory, slotId: "A", workspaceRoots: [] }); coreStores.push(persistentState);
  const resumedRuntime = runtime({ desiredStore: persistentState });
  resumedRuntime.register("platform", persistedDefinition, { label: "ignored-startup-default" }); await resumedRuntime.reconcile();
  check(resumedRuntime.status("platform", "persisted").desired.manualHold && resumedRuntime.status("platform", "persisted").desiredPersistence === "host-store", "manual hold survives real CoreStore close and reopen");
  assert.throws(() => resumedRuntime.pin("platform", service), /SERVICE_UNAVAILABLE/); checks++;
  resumedRuntime.setDesired("platform", "persisted", { enabled: true, manualHold: false }, 2); await resumedRuntime.reconcile();
  const persistedPin = resumedRuntime.pin("platform", service); check(persistedPin.value.value === "persisted-config", "reconcile restores schema-validated persisted config"); persistedPin.release();

  let verificationAllowed = false;
  const assetDirectory = path.join(directory, "assets");
  let assets = new AssetStore(assetDirectory, async () => verificationAllowed); stores.push(assets);
  const draft = assets.createDraft({ assetId: "script", revision: "1", source: "test-source", author: "author", effects: ["E3"] }, Buffer.from("original script"));
  check(draft.state === "DRAFT" && assets.readBlob(draft.contentDigest).toString() === "original script", "Asset draft stores verified content-addressed bytes");
  assert.throws(() => assets.createDraft({ assetId: "script", revision: "1", source: "changed", author: "author", effects: [] }, Buffer.from("changed")), /IMMUTABLE/); checks++;
  assert.throws(() => assets.activate("script", "1", draft.contentDigest), /NOT_VERIFIED/); checks++;
  await assert.rejects(assets.verify("script", "1", draft.contentDigest, "unproven-report"), /NOT_PROVEN/); checks++;
  verificationAllowed = true;
  await assets.verify("script", "1", draft.contentDigest, "verified-report");
  check(assets.activate("script", "1", draft.contentDigest).state === "ACTIVE", "evidence-verified revision can activate");
  const next = assets.createDraft({ assetId: "script", revision: "2", source: "test-source", author: "author", effects: [] }, Buffer.from("new script"));
  await assert.rejects(assets.verify("script", "2", draft.contentDigest, "old-report"), /STALE/); checks++;
  await assets.verify("script", "2", next.contentDigest, "new-report"); assets.activate("script", "2", next.contentDigest);
  check(assets.getAsset("script", "1").state === "DEPRECATED", "new active revision deprecates previous one atomically");
  const artifact = assets.recordArtifact({ artifactId: "test-report", producerRunId: "run-a", invocationId: "invoke-a", attemptId: "attempt-a", inputDigest: "b".repeat(64), mediaType: "text/plain", visibility: "workspace-a" }, Buffer.from("report bytes"));
  const promoted = assets.promoteArtifact(artifact.artifactId, { assetId: "template", revision: "1", source: "artifact:test-report", author: "author", effects: [] });
  check(promoted.state === "DRAFT" && promoted.promotedFromArtifactId === artifact.artifactId && promoted.contentDigest === artifact.contentDigest, "Artifact promotion records provenance and requires fresh verification");
  assets.revoke("script", "2"); assets.close();
  assets = new AssetStore(assetDirectory); stores.push(assets);
  check(assets.getAsset("script", "2").state === "REVOKED" && assets.getAsset("template", "1").promotedFromArtifactId === "test-report", "asset lifecycle and provenance persist across reopen");
  assert.throws(() => assets.activate("script", "2", next.contentDigest), /NOT_VERIFIED/); checks++;
  writeFileSync(path.join(assetDirectory, "blobs", draft.contentDigest), "tampered bytes");
  assert.throws(() => assets.readBlob(draft.contentDigest), /CORRUPTED/); checks++;
  console.log(`V3 composition: ${checks} checks passed`);
} finally {
  for (const value of runtimes) await value.close(100);
  for (const store of stores) store.close();
  for (const coreStore of coreStores) coreStore.close();
  rmSync(directory, { recursive: true, force: true });
}
