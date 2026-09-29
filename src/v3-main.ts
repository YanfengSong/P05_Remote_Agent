import { startV3Application } from "./v3/application.js";

try {
  const filename = process.env.P05_V3_CONFIG;
  if (!filename) throw new Error("P05_V3_CONFIG_REQUIRED");
  const application = await startV3Application(filename);
  process.stderr.write(JSON.stringify({ event: "p05.v3.ready", endpoint: application.endpoint, slotId: application.slotId,
    clientTokenFile: application.clientTokenFile, operatorTokenFile: application.operatorTokenFile,
    securityMode: "trusted-host", isolationVerified: false }) + "\n");
  const close = () => { void application.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "p05.v3.start_failed", code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_CONFIGURATION_OR_STATE_UNAVAILABLE" }) + "\n");
  process.exitCode = 1;
}
