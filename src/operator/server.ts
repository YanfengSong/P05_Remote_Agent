import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  bridgeRequest,
  connectRuntime,
  disconnectRuntime,
  operatorConfigView,
  operatorOverview,
  restartRuntime
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
