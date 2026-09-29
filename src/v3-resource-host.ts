import { startResourceHost } from "./v3/resources/rpc-service.js";

try {
  const filename = process.env.P05_V3_RESOURCE_CONFIG;
  if (!filename) throw new Error("P05_V3_RESOURCE_CONFIG_REQUIRED");
  const host = await startResourceHost(filename);
  process.stderr.write(JSON.stringify({ event: "p05.v3.resource.ready", hostId: host.hostId, endpoints: host.endpoints, operatorTokenFile: host.operatorTokenFile, isolationEnforced: false }) + "\n");
  const close = () => { void host.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "p05.v3.resource.start_failed", code: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "RESOURCE_CONFIGURATION_OR_STATE_UNAVAILABLE" }) + "\n");
  process.exitCode = 1;
}
