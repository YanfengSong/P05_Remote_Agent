import assert from "node:assert/strict";
import { z } from "zod";
import {
  CompositionError,
  CompositionEvents,
  CompositionRuntime,
  createServiceKey,
  type ComponentContext,
  type ComponentDefinition,
  type ComponentManifest
} from "../v3/composition/index.js";

let checks = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const schema = z.object({ label: z.string() }).strict();
const ordinary = createServiceKey<{ value: string }>("example.t46.service", "1");

function manifest(componentId: string, overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    componentId,
    revision: "1",
    entrypointDigest: "b".repeat(64),
    configVersion: "1",
    scope: "platform",
    hostCompatibility: ["win32", "linux", "darwin"],
    provides: [],
    requires: [],
    effectOwnership: [{ effect: "E1", management: "fiber" }],
    activationPolicy: "desired",
    ...overrides
  };
}

function definition(
  componentId: string,
  activate: (ctx: ComponentContext, config: Readonly<{ label: string }>) => void | Promise<void>,
  overrides: Partial<ComponentManifest> = {}
): ComponentDefinition<{ label: string }> {
  return { manifest: manifest(componentId, overrides), configSchema: schema, activate };
}

const captured = {
  actorId: "operator-a",
  authorityDigest: "authority-original",
  approvalDigest: "approval-original",
  payload: { capability: "fs_write", path: "workspace/file.txt" }
};

const hooks = new CompositionEvents(new Set(["before-submit"]), 50);
hooks.intercept("before-submit", 1, () => ({ metadata: { observer: "one" } }));
hooks.intercept("before-submit", 2, () => ({ deny: true, metadata: { policy: "deny" } }));
hooks.intercept("before-submit", 3, () => ({ deny: false, metadata: { later: "cannot-allow" } }));
const result = await hooks.apply("before-submit", captured);
check(result.denied === true, "later interceptor cannot reverse an earlier denial");
check(
  result.envelope.actorId === captured.actorId &&
  result.envelope.authorityDigest === captured.authorityDigest &&
  result.envelope.approvalDigest === captured.approvalDigest,
  "interceptors cannot rewrite captured actor/authority/approval identity"
);
check(Object.isFrozen(result.envelope) && Object.isFrozen(result.envelope.payload as object), "authorization envelope is deep frozen");

const injection = new CompositionEvents(new Set(["before-submit"]), 50);
injection.intercept("before-submit", 0, () => ({
  deny: false,
  authorityDigest: "authority-attacker"
} as unknown as { deny: boolean }));
await assert.rejects(
  injection.apply("before-submit", captured),
  (error: unknown) => error instanceof CompositionError && error.code === "INTERCEPTOR_INVALID_RESULT"
);
checks++;
check(captured.authorityDigest === "authority-original", "invalid interceptor output cannot mutate publisher authorization state");

const throwing = new CompositionEvents(new Set(["before-submit"]), 50);
throwing.intercept("before-submit", 0, () => { throw new Error("PRIVATE_AUTH_PLUGIN_SECRET"); });
await assert.rejects(
  throwing.apply("before-submit", captured),
  (error: unknown) =>
    error instanceof CompositionError &&
    error.code === "INTERCEPTOR_FAILED" &&
    !error.message.includes("PRIVATE_AUTH_PLUGIN_SECRET")
);
checks++;

const timeout = new CompositionEvents(new Set(["before-submit"]), 5);
timeout.intercept("before-submit", 0, async () => new Promise(() => undefined));
await assert.rejects(
  timeout.apply("before-submit", captured),
  (error: unknown) => error instanceof CompositionError && error.code === "HOOK_TIMEOUT"
);
checks++;

for (const protectedName of [
  "p05.trust.kernel",
  "p05.authorization.decision",
  "p05.storage.integrity",
  "p05.updater.apply"
]) {
  const runtime = new CompositionRuntime();
  runtime.createScope({ id: "platform", kind: "platform" });
  const key = createServiceKey<unknown>(protectedName, "1");
  assert.throws(
    () => runtime.register(
      "platform",
      definition(
        "protected-" + checks,
        (ctx) => ctx.provide(key, {}),
        { provides: [{ key, kind: "single" }] }
      ),
      { label: "forbidden" }
    ),
    (error: unknown) => error instanceof CompositionError && error.code === "PROTECTED_SERVICE_PROVIDER"
  );
  checks++;
  await runtime.close();
}

const replaceRuntime = new CompositionRuntime();
replaceRuntime.createScope({ id: "platform", kind: "platform" });
replaceRuntime.register(
  "platform",
  definition(
    "replaceable",
    (ctx, config) => ctx.provide(ordinary, { value: config.label }),
    { provides: [{ key: ordinary, kind: "single" }] }
  ),
  { label: "old" }
);
await replaceRuntime.reconcile();
const before = replaceRuntime.pin("platform", ordinary);
check(before.value.value === "old", "baseline provider is active before replacement attempt");
before.release();

const protectedReplacementKey = createServiceKey<unknown>("p05.authorization.hot-replace", "1");
await assert.rejects(
  replaceRuntime.replace(
    "platform",
    "replaceable",
    definition(
      "replaceable",
      (ctx) => ctx.provide(protectedReplacementKey, {}),
      {
        revision: "2",
        provides: [{ key: protectedReplacementKey, kind: "single" }]
      }
    ),
    { label: "malicious" },
    1
  ),
  (error: unknown) => error instanceof CompositionError && error.code === "PROTECTED_SERVICE_PROVIDER"
);
checks++;
const retained = replaceRuntime.pin("platform", ordinary);
check(
  retained.value.value === "old" &&
  replaceRuntime.status("platform", "replaceable").appliedRevision === 1,
  "failed trust-root replacement preserves the previous business binding"
);
retained.release();
await replaceRuntime.close();

let externalCalls = 0;
const shadowRuntime = new CompositionRuntime({
  executeExternal: async () => {
    externalCalls++;
    return { applied: true };
  }
});
shadowRuntime.createScope({ id: "platform", kind: "platform" });
shadowRuntime.createScope({ id: "candidate-shadow", kind: "shadow", parentId: "platform" });
shadowRuntime.register(
  "candidate-shadow",
  definition(
    "shadow-candidate",
    async (ctx) => {
      await ctx.external("E2", "process-manager", "would-run", { executable: "forbidden" });
    },
    {
      scope: "shadow",
      effectOwnership: [{ effect: "E2", management: "external", manager: "process-manager" }]
    }
  ),
  { label: "shadow" }
);
await shadowRuntime.reconcile();
check(shadowRuntime.status("candidate-shadow", "shadow-candidate").observed === "FAILED", "shadow external effect attempt fails closed");
check(externalCalls === 0, "shadow candidate never reaches the real external effect manager");
await shadowRuntime.close();

console.log(`V3_T46_AUTHORIZATION_INVARIANCE_OK (${checks} checks: sticky deny, immutable authority, interceptor fail-closed, protected trust services, shadow zero effects)`);