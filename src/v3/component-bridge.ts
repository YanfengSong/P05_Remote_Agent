import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { createRpcClient } from "./transport/rpc.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";
import { DurableError, UnconfirmedOutcome, type Capability, type Json } from "./durable/types.js";

/** Only explicitly allowlisted E0 capabilities. Component operator credentials never enter this bridge. */
export async function createComponentBridge(options: { connectionFile: string; slotId: string; principal: string; workspaceRoot: string; allowlist: string[] }) {
  const workspace = fs.realpathSync(options.workspaceRoot);
  const privateFile = async (requested: string) => {
    if (!path.isAbsolute(requested)) throw new Error("COMPONENT_CONNECTION_PATH_INVALID");
    const file = fs.realpathSync(requested);
    const relative = path.relative(workspace, file);
    if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("COMPONENT_CONNECTION_IN_WORKSPACE");
    if (!(await verifyConfigurationProtection(file)).verified || !(await verifyStateProtection(path.dirname(file))).verified) throw new Error("COMPONENT_CONNECTION_UNPROTECTED");
    return file;
  };
  const file = await privateFile(options.connectionFile);
  if (fs.statSync(file).size > 256 * 1024) throw new Error("COMPONENT_CONNECTION_SIZE_LIMIT");
  const connection = z.object({ endpoint: z.string(), clientTokenFile: z.string(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const tokenFile = await privateFile(connection.clientTokenFile);
  if (fs.statSync(tokenFile).size > 1024) throw new Error("COMPONENT_CREDENTIAL_SIZE_LIMIT");
  const rpc = createRpcClient({ url: connection.endpoint, token: fs.readFileSync(tokenFile, "utf8").trim(), timeoutMs: 5000 });
  const status = z.object({ slotId: z.literal(options.slotId), principalId: z.literal(options.principal), workspaceRoot: z.string(),
    bindingDigest: z.literal(connection.bindingDigest), securityMode: z.literal("trusted-local-plugin"), isolationEnforced: z.literal(false),
    capabilities: z.array(z.object({ capabilityId: z.string(), effect: z.enum(["E0", "E1"]), bindingId: z.string().uuid().nullable(), description: z.string().optional() }).passthrough()).max(256)
  }).passthrough().parse(await rpc.call("component_status", {}));
  if (fs.realpathSync(status.workspaceRoot) !== workspace) throw new Error("COMPONENT_WORKSPACE_BINDING_MISMATCH");
  const selected = options.allowlist.map(id => {
    const capability = status.capabilities.find(c => c.capabilityId === id);
    if (!capability || capability.effect !== "E0" || !capability.bindingId) throw new Error("COMPONENT_READ_BINDING_UNAVAILABLE");
    return capability;
  });
  const metadata = selected.map(c => ({ capability: "component:" + c.capabilityId, effect: "E0", authority: ["Read"], description: c.description ?? c.capabilityId,
    inputSchema: {}, securityMode: "trusted-local-plugin", isolationEnforced: false }));
  const capabilities: Capability[] = selected.map(c => ({ capability: "component:" + c.capabilityId, capabilityVersion: "1", bindingVersion: c.bindingId!,
    async execute({ run, input, signal }) {
      if (run.context.slotId !== options.slotId || run.context.principal !== options.principal || run.context.workspaceRoot !== workspace) throw new DurableError("COMPONENT_OWNER_MISMATCH", "Component owner mismatch");
      if (signal.aborted) throw new UnconfirmedOutcome("COMPONENT_OBSERVATION_ABORTED", { dispatched: false });
      let raw: unknown;
      try { raw = await rpc.call("component_call", { capabilityId: c.capabilityId, input, runId: run.executionId, expectedBindingId: c.bindingId }); }
      catch { throw new UnconfirmedOutcome("COMPONENT_RESPONSE_UNCONFIRMED", { bindingId: c.bindingId }); }
      if (raw && typeof raw === "object" && "error" in raw) throw new DurableError("COMPONENT_CALL_REJECTED", "Component call rejected");
      const reply = z.object({ capabilityId: z.literal(c.capabilityId), effect: z.literal("E0"), bindingId: z.literal(c.bindingId!), bindingDigest: z.literal(connection.bindingDigest), result: z.json() }).strict().parse(raw);
      if (Buffer.byteLength(JSON.stringify(reply.result)) > 48 * 1024) throw new DurableError("COMPONENT_OUTPUT_LIMIT", "Component result exceeds the inline output budget");
      return reply.result as Json;
    }
  }));
  return { capabilities, metadata, validateInput(capability: string, input: Json) {
    if (!capabilities.some(c => c.capability === capability)) throw new DurableError("UNKNOWN_CAPABILITY", "Component capability not allowlisted");
    z.json().parse(input);
  } };
}
