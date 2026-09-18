import * as z from "zod/v4";
import type { ToolGate } from "../policy/gate.js";
import type { Exposer } from "../policy/expose.js";

export function registerPolicyTool(exposer: Exposer, gate: ToolGate): void {
  exposer.expose("policy_info", {
    description:
      "Report the active P05 tool profile: which tools are exposed, which are suppressed and why, " +
      "and which local unlock flags are set.",
    inputSchema: z.object({})
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(gate.report(), null, 2) }]
  }));
}
