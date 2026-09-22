import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  bridgeRequest,
  bridgeRequestForSlot,
  chooseWorkspaceFolder,
  connectRuntime,
  connectRuntimeSlot,
  disconnectRuntime,
  disconnectRuntimeSlot,
  operatorConfigView,
  operatorOverview,
  persistRuntimeSlotWorkspace,
  restartRuntime,
  restartRuntimeSlot
} from "./runtime-control.js";
import { operatorPage } from "./ui.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.P05_OPERATOR_PORT ?? "56301");
const token = randomBytes(32).toString("hex");
const startedAt = new Date().toISOString();

type OperatorActionName = "connect" | "disconnect" | "restart";
type OperatorActionState = {
  action: OperatorActionName;
  state: "waiting" | "succeeded" | "failed";
  requestedAt: string;
  finishedAt?: string;
  message?: string;
  error?: string;
  previousBridgeStartedAt?: string;
};

let lastAction: OperatorActionState | undefined;

function bridgeStartedAt(overview: any): string | undefined {
  const value = overview?.connection?.bridge?.data?.startedAt;
  return typeof value === "string" ? value : undefined;
}

function settleAction(overview: any): void {
  if (!lastAction || lastAction.state !== "waiting") return;

  const age = Date.now() - Date.parse(lastAction.requestedAt);
  const connected = Boolean(overview?.connection?.connected);
  let complete = false;

  if (lastAction.action === "connect") {
    complete = connected;
  } else if (lastAction.action === "disconnect") {
    complete = !connected;
  } else {
    const currentBridge = bridgeStartedAt(overview);
    complete = Boolean(
      connected &&
      currentBridge &&
      (
        !lastAction.previousBridgeStartedAt ||
        currentBridge !== lastAction.previousBridgeStartedAt
      )
    );
  }

  if (complete) {
    lastAction = {
      ...lastAction,
      state: "succeeded",
      finishedAt: new Date().toISOString(),
      message:
        lastAction.action === "connect"
          ? "P05 已连接。"
          : lastAction.action === "disconnect"
            ? "P05 已断开，Operator Console 仍在线。"
            : "P05 Runtime 已完成重启并重新上线。"
    };
  } else if (age > 90_000) {
    lastAction = {
      ...lastAction,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: "操作在 90 秒内没有达到目标状态。"
    };
  }
}

async function beginAction(
  action: OperatorActionName,
  operation: () => Promise<unknown>
): Promise<OperatorActionState> {
  const before = await operatorOverview();
  lastAction = {
    action,
    state: "waiting",
    requestedAt: new Date().toISOString(),
    ...(action === "restart"
      ? { previousBridgeStartedAt: bridgeStartedAt(before) }
      : {})
  };

  try {
    await operation();
    return lastAction;
  } catch (error) {
    lastAction = {
      ...lastAction,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
    throw error;
  }
}

function json(
  response: http.ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function html(response: http.ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  response.end(body);
}

async function bodyJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 32 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function authorized(request: http.IncomingMessage): boolean {
  return request.headers["x-p05-operator-token"] === token;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

    if (request.method === "GET" && url.pathname === "/") {
      html(response, operatorPage(token));
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        status: "ok",
        name: "p05-operator-console",
        startedAt,
        pid: process.pid
      });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "not found" });
      return;
    }

    if (!authorized(request)) {
      json(response, 403, { error: "operator token required" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/operator/shutdown") {
      json(response, 200, {
        ok: true,
        action: "shutdown",
        message: "Operator Console shutdown requested."
      });
      setTimeout(() => close("operator-ui"), 100);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const overview = await operatorOverview();
      settleAction(overview);
      json(response, 200, {
        ...overview,
        operator: {
          startedAt,
          pid: process.pid,
          host: HOST,
          port: PORT,
          config: operatorConfigView,
          action: lastAction
        }
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action/connect") {
      json(response, 200, await beginAction("connect", connectRuntime));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action/disconnect") {
      json(response, 200, await beginAction("disconnect", disconnectRuntime));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action/restart") {
      json(response, 200, await beginAction("restart", restartRuntime));
      return;
    }

    const slotActionMatch = url.pathname.match(/^\/api\/slot\/(A|B)\/action\/(connect|disconnect|restart)$/);
    if (request.method === "POST" && slotActionMatch) {
      const slot = slotActionMatch[1] as "A" | "B";
      const action = slotActionMatch[2];
      const result =
        action === "connect"
          ? await connectRuntimeSlot(slot)
          : action === "disconnect"
            ? await disconnectRuntimeSlot(slot)
            : await restartRuntimeSlot(slot);
      json(response, 200, result);
      return;
    }

    const slotReferenceAddMatch = url.pathname.match(
      /^\/api\/slot\/(A|B)\/reference\/root$/
    );
    if (request.method === "POST" && slotReferenceAddMatch) {
      const slot = slotReferenceAddMatch[1] as "A" | "B";
      const body = await bodyJson(request);
      const root = typeof body.root === "string" ? body.root.trim() : "";
      if (!root) throw new Error("Reference root is required.");
      const result = await bridgeRequestForSlot(slot, "/api/reference/root", {
        method: "POST",
        body: JSON.stringify({ root })
      });
      json(response, 200, result);
      return;
    }

    const slotReferenceRemoveMatch = url.pathname.match(
      /^\/api\/slot\/(A|B)\/reference\/([a-z0-9][a-z0-9._-]{0,63})\/remove$/
    );
    if (request.method === "POST" && slotReferenceRemoveMatch) {
      const slot = slotReferenceRemoveMatch[1] as "A" | "B";
      const referenceId = slotReferenceRemoveMatch[2]!;
      const result = await bridgeRequestForSlot(
        slot,
        `/api/reference/${referenceId}/remove`,
        { method: "POST", body: "{}" }
      );
      json(response, 200, result);
      return;
    }

    const slotReferencePickMatch = url.pathname.match(
      /^\/api\/slot\/(A|B)\/reference\/pick$/
    );
    if (request.method === "POST" && slotReferencePickMatch) {
      json(response, 200, await chooseWorkspaceFolder());
      return;
    }

    const slotPluginActionMatch = url.pathname.match(
      /^\/api\/slot\/(A|B)\/plugin\/([a-z0-9][a-z0-9._-]{0,63})\/action\/(start|stop)$/
    );
    if (request.method === "POST" && slotPluginActionMatch) {
      const slot = slotPluginActionMatch[1] as "A" | "B";
      const pluginId = slotPluginActionMatch[2]!;
      const action = slotPluginActionMatch[3]!;
      const result = await bridgeRequestForSlot(
        slot,
        `/api/plugin/${pluginId}/action/${action}`,
        { method: "POST", body: "{}" }
      );
      json(response, 200, result);
      return;
    }

    const slotMatch = url.pathname.match(/^\/api\/slot\/(A|B)\/workspace\/(select|pick|root|register)$/);
    if (request.method === "POST" && slotMatch) {
      const slot = slotMatch[1] as "A" | "B";
      const action = slotMatch[2];

      if (action === "pick") {
        json(response, 200, await chooseWorkspaceFolder());
        return;
      }

      if (action === "select") {
        const body = await bodyJson(request);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) throw new Error("Workspace id is required.");
        const result = await bridgeRequestForSlot(slot, "/api/workspace/select", {
          method: "POST",
          body: JSON.stringify({ id })
        });
        persistRuntimeSlotWorkspace(slot, id);
        json(response, 200, result);
        return;
      }

      if (action === "root") {
        const body = await bodyJson(request);
        const root = typeof body.root === "string" ? body.root.trim() : "";
        if (!root) throw new Error("Workspace root is required.");
        let result = await bridgeRequestForSlot(slot, "/api/workspace/root", {
          method: "POST",
          body: JSON.stringify({ root })
        });
        let workspaceId =
          result &&
          typeof result === "object" &&
          "workspace" in result &&
          typeof (result as { workspace?: { id?: unknown } }).workspace?.id === "string"
            ? (result as { workspace: { id: string } }).workspace.id
            : "";
        if (workspaceId === "operator-session") {
          result = await bridgeRequestForSlot(slot, "/api/workspace/register", {
            method: "POST",
            body: "{}"
          });
          workspaceId =
            result &&
            typeof result === "object" &&
            "workspace" in result &&
            typeof (result as { workspace?: { id?: unknown } }).workspace?.id === "string"
              ? (result as { workspace: { id: string } }).workspace.id
              : "";
        }
        if (!workspaceId) throw new Error("Workspace binding did not return a registered id.");
        persistRuntimeSlotWorkspace(slot, workspaceId);
        json(response, 200, result);
        return;
      }

      const result = await bridgeRequestForSlot(slot, "/api/workspace/register", {
        method: "POST",
        body: "{}"
      });
      const workspaceId =
        result &&
        typeof result === "object" &&
        "workspace" in result &&
        typeof (result as { workspace?: { id?: unknown } }).workspace?.id === "string"
          ? (result as { workspace: { id: string } }).workspace.id
          : "";
      if (!workspaceId) throw new Error("Workspace registration did not return an id.");
      persistRuntimeSlotWorkspace(slot, workspaceId);
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/select") {
      const body = await bodyJson(request);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) throw new Error("Workspace id is required.");
      const result = await bridgeRequest("/api/workspace/select", {
        method: "POST",
        body: JSON.stringify({ id })
      });
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/pick") {
      json(response, 200, await chooseWorkspaceFolder());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/root") {
      const body = await bodyJson(request);
      const root = typeof body.root === "string" ? body.root.trim() : "";
      if (!root) throw new Error("Workspace root is required.");
      const result = await bridgeRequest("/api/workspace/root", {
        method: "POST",
        body: JSON.stringify({ root })
      });
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/register") {
      const result = await bridgeRequest("/api/workspace/register", {
        method: "POST",
        body: "{}"
      });
      json(response, 200, result);
      return;
    }

    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    JSON.stringify({
      event: "p05.operator.started",
      url: `http://${HOST}:${PORT}`,
      pid: process.pid,
      startedAt
    }) + "\n"
  );
});

function close(signal: string): void {
  server.close(() => {
    process.stdout.write(
      JSON.stringify({
        event: "p05.operator.stopped",
        signal,
        stoppedAt: new Date().toISOString()
      }) + "\n"
    );
    process.exit(0);
  });
}

process.once("SIGINT", () => close("SIGINT"));
process.once("SIGTERM", () => close("SIGTERM"));
