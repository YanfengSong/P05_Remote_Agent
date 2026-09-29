import { inspectV3Recovery, resumeV3Recovery } from "./v3/recovery.js";

// Local-only maintenance CLI. No network-facing recovery or arbitrary state-directory override.
try {
  const [configFile, action, expectedOwnerId, reason, ...extra] = process.argv.slice(2);
  if (!configFile || extra.length || (action !== "inspect" && action !== "resume") ||
      (action === "inspect" && (expectedOwnerId !== undefined || reason !== undefined)) ||
      (action === "resume" && (!expectedOwnerId || reason === undefined))) {
    throw new Error("RECOVERY_USAGE: v3-recovery <config> inspect | resume <expectedOwnerId> <reason>");
  }
  if (action === "inspect") {
    process.stdout.write(JSON.stringify(await inspectV3Recovery(configFile), null, 2) + "\n");
  } else {
    const application = await resumeV3Recovery(configFile, expectedOwnerId!, reason!);
    const status = application.status();
    process.stdout.write(JSON.stringify({ event: "p05.v3.recovered", endpoint: application.endpoint,
      slotId: application.slotId, coreInstanceId: status.coreInstanceId, instanceGeneration: status.instanceGeneration }) + "\n");
    const close = () => { void application.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
} catch (error) {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : undefined;
  const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(candidate) ? candidate : "RECOVERY_LOCAL_CONFIGURATION_OR_STATE_UNAVAILABLE";
  process.stderr.write(JSON.stringify({ event: "p05.v3.recovery_failed", code }) + "\n");
  if (error instanceof Error && error.message.startsWith("RECOVERY_USAGE:")) process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
