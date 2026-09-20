import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const STATE = path.join(REPO, "_p05_audit_correlation_test");
const serverEntry = path.resolve(here, "..", "index.js");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !key.startsWith("P05_")) env[key] = value;
  }
  env.REMOTE_AGENT_ALLOWED_ROOTS = REPO;
  env.REMOTE_AGENT_DEFAULT_CWD = REPO;
  env.P05_TOOL_PROFILE = "developer";
  env.P05_REFERENCE_AGENT_ENABLED = "true";
  env.P05_STATE_DIR = STATE;
  env.MATLAB_MCP_ENABLED = "false";
  return env;
}

function structured(result: unknown): Record<string, unknown> {
  const value = (result as { structuredContent?: unknown })?.structuredContent;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected structuredContent object.");
  }
  return value as Record<string, unknown>;
}

await fs.rm(STATE, { recursive: true, force: true });
const client = new Client({ name: "p05-audit-correlation-test", version: VERSION });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: inheritedEnv(),
  stderr: "pipe"
});

let sessionId = "";
try {
  await client.connect(transport);

  const start = structured(await client.callTool({
    name: "agent_start",
    arguments: { provider: "reference-stdio" }
  }));
  sessionId = String(start.id ?? "");
  const actorId = String(start.actorId ?? "");
  check("audit-correlation: agent_start returns session id", sessionId.startsWith("session-"), sessionId);
  check("audit-correlation: agent_start returns actor id", actorId.startsWith("agent-"), actorId);

  await client.callTool({
    name: "agent_task",
    arguments: { session_id: sessionId, task: "correlation-probe" }
  });

  const activity = structured(await client.callTool({
    name: "activity_recent",
    arguments: { limit: 30 }
  }));
  const events = Array.isArray(activity.events) ? activity.events as Array<Record<string, unknown>> : [];
  const startEvent = events.find((event) => event.capability === "agent_start");
  const taskEvent = events.find((event) => event.capability === "agent_task");

  check("audit-correlation: agent_start event exists", Boolean(startEvent), JSON.stringify(events));
  check("audit-correlation: agent_task event exists", Boolean(taskEvent), JSON.stringify(events));
  check("audit-correlation: start event links session", startEvent?.sessionId === sessionId, JSON.stringify(startEvent));
  check("audit-correlation: task event links same session", taskEvent?.sessionId === sessionId, JSON.stringify(taskEvent));
  check("audit-correlation: actor type is agent", taskEvent?.actorType === "agent", JSON.stringify(taskEvent));
  check("audit-correlation: actor id is stable", taskEvent?.actorId === actorId, JSON.stringify(taskEvent));

  const sessionsState = await fs.readFile(path.join(STATE, "sessions.json"), "utf8");
  check("audit-correlation: task payload is absent from persisted session state",
    !sessionsState.includes("correlation-probe"),
    sessionsState
  );

  console.log(`AUDIT_CORRELATION_OK (${checks} checks)`);
} finally {
  if (sessionId) {
    await client.callTool({
      name: "agent_stop",
      arguments: { session_id: sessionId, force: true }
    }).catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await fs.rm(STATE, { recursive: true, force: true }).catch(() => undefined);
}
