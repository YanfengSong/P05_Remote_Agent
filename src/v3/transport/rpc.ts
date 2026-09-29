import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

export type RpcRole = "client" | "operator";
export type RpcServerOptions = {
  clientToken: string;
  operatorToken: string;
  handle: (method: string, input: unknown, role: RpcRole) => Promise<unknown>;
  port?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
};
export type RpcServer = { url: string; close(): Promise<void> };

const METHOD_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const DEFAULT_REQUEST_BYTES = 256 * 1024;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error("Invalid RPC limit.");
  }
  return result;
}

function validToken(token: string): boolean {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(token);
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function send(response: http.ServerResponse, status: number, body: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function failure(response: http.ServerResponse, status: number, code: string): void {
  if (!response.destroyed && !response.writableEnded) response.setHeader("connection", "close");
  send(response, status, JSON.stringify({ ok: false, error: { code } }));
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
    };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const aborted = () => fail(new RequestError(400, "INVALID_REQUEST"));
    const data = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > limit) { fail(new RequestError(413, "REQUEST_TOO_LARGE")); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestError(400, "INVALID_REQUEST")); }
    };
    const timer = setTimeout(() => fail(new RequestError(408, "REQUEST_TIMEOUT")), 15_000);
    request.on("data", data);
    request.once("end", end);
    request.once("error", fail);
    request.once("aborted", aborted);
  });
}

/** A private, authenticated loopback RPC bridge; never a public MCP endpoint. */
export async function startRpcServer(options: RpcServerOptions): Promise<RpcServer> {
  if (!validToken(options.clientToken) || !validToken(options.operatorToken) || options.clientToken === options.operatorToken) {
    throw new Error("RPC requires distinct client and operator tokens of at least 32 safe characters.");
  }
  const requestLimit = bound(options.maxRequestBytes, DEFAULT_REQUEST_BYTES, 16 * 1024 * 1024);
  const responseLimit = bound(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES, 16 * 1024 * 1024);
  const concurrencyLimit = bound(options.maxConcurrent, 32, 1024);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid RPC port.");
  const clientDigest = tokenDigest(options.clientToken);
  const operatorDigest = tokenDigest(options.operatorToken);
  const active = new Set<Promise<void>>();
  let authority = "";
  let closing = false;

  const processRequest = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    try {
      if (request.headers.host !== authority ||
        (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)) {
        failure(response, 403, "INVALID_ORIGIN");
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        send(response, 200, '{"alive":true}');
        return;
      }
      if (request.method !== "POST" || request.url !== "/rpc") {
        failure(response, 404, "NOT_FOUND");
        return;
      }
      const authorization = request.headers.authorization ?? "";
      const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      // Hash to fixed width, then perform BOTH comparisons, irrespective of role.
      const candidateDigest = tokenDigest(candidate);
      const isClient = timingSafeEqual(candidateDigest, clientDigest);
      const isOperator = timingSafeEqual(candidateDigest, operatorDigest);
      const authorizationCount = request.rawHeaders.filter((_, index) => index % 2 === 0)
        .filter((name) => name.toLowerCase() === "authorization").length;
      if (authorizationCount !== 1 || (!isClient && !isOperator)) {
        failure(response, 401, "UNAUTHORIZED");
        return;
      }
      if (closing) {
        failure(response, 503, "UNAVAILABLE");
        return;
      }
      if (active.size >= concurrencyLimit) {
        failure(response, 429, "BUSY");
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
        failure(response, 415, "INVALID_CONTENT_TYPE");
        return;
      }
      const length = request.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > requestLimit)) {
        failure(response, 413, "REQUEST_TOO_LARGE");
        return;
      }
      const operation = (async (): Promise<void> => {
        const envelope = await readBody(request, requestLimit);
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
          throw new RequestError(400, "INVALID_REQUEST");
        }
        const record = envelope as Record<string, unknown>;
        if (Object.keys(record).some((key) => key !== "method" && key !== "input") ||
          typeof record.method !== "string" || !METHOD_PATTERN.test(record.method)) {
          throw new RequestError(400, "INVALID_REQUEST");
        }
        // Disconnect is a transport event. It must not cancel accepted work.
        const result = await options.handle(record.method, record.input, isOperator ? "operator" : "client");
        const body = JSON.stringify({ ok: true, result: result ?? null });
        if (Buffer.byteLength(body) > responseLimit) throw new RequestError(502, "RESPONSE_TOO_LARGE");
        send(response, 200, body);
      })();
      active.add(operation);
      try { await operation; } finally { active.delete(operation); }
    } catch (error) {
      if (error instanceof RequestError) failure(response, error.status, error.code);
      else failure(response, 500, "INTERNAL_ERROR");
    }
  };

  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
    void processRequest(request, response);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC listener unavailable.");
  authority = `127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  return {
    url: `http://${authority}`,
    close() {
      return closed ??= (async () => {
        closing = true;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await Promise.allSettled([...active]);
      })();
    }
  };
}

export class RpcError extends Error {
  constructor(readonly code: string) {
    super(`V3 transport: ${code}`);
    this.name = "RpcError";
  }
}

export type RpcClient = {
  call(method: string, input?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};

export function createRpcClient(options: {
  url: string;
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): RpcClient {
  let endpoint: URL;
  try { endpoint = new URL(options.url); } catch { throw new RpcError("INVALID_ENDPOINT"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new RpcError("INVALID_ENDPOINT");
  }
  if (!validToken(options.token)) throw new RpcError("INVALID_CREDENTIAL");
  endpoint.pathname = "/rpc";
  const timeoutMs = bound(options.timeoutMs, 35_000, 120_000);
  const responseLimit = bound(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES, 16 * 1024 * 1024);
  return {
    async call(method, input, callOptions = {}) {
      if (!METHOD_PATTERN.test(method)) throw new RpcError("INVALID_METHOD");
      const timeout = bound(callOptions.timeoutMs, timeoutMs, 120_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify({ method, input })
        });
        if (!response.body) throw new RpcError("INVALID_RESPONSE");
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > responseLimit) {
            await reader.cancel();
            throw new RpcError("RESPONSE_TOO_LARGE");
          }
          parts.push(next.value);
        }
        const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError("INVALID_RESPONSE");
        if (!response.ok || value.ok !== true) {
          const code = (value.error as { code?: unknown } | undefined)?.code;
          const known = new Set(["INVALID_ORIGIN", "NOT_FOUND", "UNAUTHORIZED", "UNAVAILABLE", "BUSY", "INVALID_CONTENT_TYPE", "REQUEST_TOO_LARGE", "REQUEST_TIMEOUT", "INVALID_REQUEST", "RESPONSE_TOO_LARGE", "INTERNAL_ERROR"]);
          throw new RpcError(typeof code === "string" && known.has(code) ? code : "REQUEST_FAILED");
        }
        return value.result;
      } catch (error) {
        if (error instanceof RpcError) throw error;
        throw new RpcError(controller.signal.aborted ? "WAIT_TIMEOUT" : "CONNECTION_FAILED");
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
