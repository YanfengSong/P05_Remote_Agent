import * as z from "zod/v4";
import { getDeviceInfo, getPingInfo } from "../device/identity.js";
import type { Exposer } from "../policy/expose.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerDeviceTools(exposer: Exposer): void {
  exposer.expose("device_info", {
    description: "Return the identity and basic runtime information for this P05 Remote Agent computer.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: asText(getDeviceInfo()) }]
  }));

  exposer.expose("ping", {
    description: "Confirm that this P05 Remote Agent computer is online and responding.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: asText(getPingInfo()) }]
  }));
}
