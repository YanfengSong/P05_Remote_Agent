import { startV3Application, type V3LifecycleHooks } from "./v3/application.js";

try {
  const filename = process.env.P05_V3_CONFIG;
  if (!filename) throw new Error("P05_V3_CONFIG_REQUIRED");

  const emit = (value: unknown) => process.stderr.write(JSON.stringify(value) + "\n");
  let stopping = false;
  let restarting = false;
  let application: Awaited<ReturnType<typeof startV3Application>>;

  const lifecycle: V3LifecycleHooks = {
    restartAfterAck: async (lifecycleId) => {
      if (stopping || restarting) return;
      restarting = true;
      const previous = application;
      const before = previous.status();
      try {
        await previous.close();
        if (stopping) return;
        const next = await startV3Application(filename, {}, lifecycle);
        application = next;
        const receipt = next.completeLifecycleRestart(lifecycleId);
        const current = next.status();
        emit({
          event: "p05.v3.restarted", lifecycleId,
          endpoint: next.endpoint, slotId: next.slotId,
          coreInstanceId: current.coreInstanceId,
          instanceGeneration: current.instanceGeneration,
          previousCoreInstanceId: before.coreInstanceId,
          previousGeneration: before.instanceGeneration,
          receipt
        });
      } catch (error) {
        emit({ event: "p05.v3.restart_failed", lifecycleId, code: "LIFECYCLE_RESTART_FAILED" });
        process.exitCode = 1;
        throw error;
      } finally {
        restarting = false;
      }
    }
  };

  application = await startV3Application(filename, {}, lifecycle);
  const initial = application.status();
  emit({
    event: "p05.v3.ready", endpoint: application.endpoint, slotId: application.slotId,
    clientTokenFile: application.clientTokenFile, operatorTokenFile: application.operatorTokenFile,
    coreInstanceId: initial.coreInstanceId, instanceGeneration: initial.instanceGeneration,
    securityMode: "trusted-host", isolationVerified: false
  });

  const close = () => {
    if (stopping) return;
    stopping = true;
    void application.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  process.stderr.write(JSON.stringify({
    event: "p05.v3.start_failed",
    code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_CONFIGURATION_OR_STATE_UNAVAILABLE"
  }) + "\n");
  process.exitCode = 1;
}
