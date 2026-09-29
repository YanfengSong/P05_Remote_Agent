import { startComponentHost } from "./v3/component-host/host.js";

try {
  const filename = process.env.P05_V3_COMPONENT_CONFIG;
  if (!filename) throw new Error("P05_V3_COMPONENT_CONFIG_REQUIRED");
  const host = await startComponentHost(filename);
  process.stderr.write(JSON.stringify({ event: "p05.v3.component.ready", endpoint: host.endpoint, slotId: host.slotId, principalId: host.principalId, bindingDigest: host.bindingDigest, clientTokenFile: host.clientTokenFile, operatorTokenFile: host.operatorTokenFile, isolationEnforced: false }) + "\n");
  const close = () => { void host.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "p05.v3.component.start_failed", code: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "COMPONENT_CONFIGURATION_OR_STATE_UNAVAILABLE" }) + "\n");
  process.exitCode = 1;
}
