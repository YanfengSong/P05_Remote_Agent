import fs from "node:fs";
import path from "node:path";
import { createRpcClient } from "./v3/transport/rpc.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./v3/protection.js";

// Local CLI only. Its Operator credential must never be copied to the MCP client configuration.
const [connectionFile, action, approvalId, version] = process.argv.slice(2);
try {
  if (!connectionFile || !["status", "approvals", "inspect", "approve", "deny"].includes(action ?? "")) {
    throw new Error("Usage: v3-operator <connection.json> status|approvals|inspect|approve|deny [executionId or approvalId] [decisionVersion]");
  }
  if (!(await verifyStateProtection(path.dirname(path.resolve(connectionFile)))).verified || !(await verifyConfigurationProtection(connectionFile)).verified || fs.statSync(connectionFile).size > 65536) throw new Error("Unprotected local connection");
  const connection = JSON.parse(fs.readFileSync(connectionFile, "utf8")) as { endpoint: string };
  const tokenFile = path.join(path.dirname(path.resolve(connectionFile)), "operator.token");
  if (!(await verifyConfigurationProtection(tokenFile)).verified || fs.statSync(tokenFile).size > 1024) throw new Error("Unprotected local credential");
  const rpc = createRpcClient({ url: connection.endpoint, token: fs.readFileSync(tokenFile, "utf8").trim() });
  let result: unknown;
  if (action === "status") result = await rpc.call("core_status", {});
  else if (action === "approvals") result = await rpc.call("operator_approvals", {});
  else if (action === "inspect") {
    if (!approvalId) throw new Error("Execution ID required");
    result = await rpc.call("operator_inspect", { id: approvalId });
  }
  else {
    const decisionVersion = Number(version);
    if (!approvalId || !version || !Number.isSafeInteger(decisionVersion) || decisionVersion < 0) throw new Error("Approval ID and decision version are required");
    result = await rpc.call("operator_decide", { approvalId, expectedDecisionVersion: decisionVersion, decision: action === "approve" ? "APPROVE" : "DENY" });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result && typeof result === "object" && "error" in result) process.exitCode = 1;
} catch (error) {
  process.stderr.write(error instanceof Error && error.message.startsWith("Usage:") ? error.message + "\n" : "Operator request failed; verify local connection and credentials.\n");
  process.exitCode = 1;
}
