import * as z from "zod/v4";
import { getDeviceInfo, getPingInfo } from "../device/identity.js";
import type { Exposer } from "../policy/expose.js";
import { structuredResult } from "./result.js";

const deviceInfoOutput = z.object({
  deviceId: z.string(),
  hostname: z.string(),
  platform: z.string(),
  release: z.string(),
  arch: z.string(),
  agentVersion: z.string(),
  status: z.string(),
  identityCreatedAt: z.string(),
  startedAt: z.string()
});

const pingOutput = z.object({
  ok: z.boolean(),
  deviceId: z.string(),
  hostname: z.string(),
  status: z.string(),
  timestamp: z.string()
});

export function registerDeviceTools(exposer: Exposer): void {
  exposer.expose("device_info", {
    description: "Return the identity and basic runtime information for this P05 Remote Agent computer.",
    inputSchema: z.object({}),
    outputSchema: deviceInfoOutput
  }, async () => {
    const output = getDeviceInfo();
    return structuredResult(output);
  });

  exposer.expose("ping", {
    description: "Confirm that this P05 Remote Agent computer is online and responding.",
    inputSchema: z.object({}),
    outputSchema: pingOutput
  }, async () => {
    const output = getPingInfo();
    return structuredResult(output);
  });
}
