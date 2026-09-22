import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { Readable } from "node:stream";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { AuditStore } from "../audit/store.js";
import { CapabilityCatalog } from "../capability/registry.js";
import { config, readOwnEnv } from "../config.js";
import { LiveActivityStore } from "../monitor/live-activity.js";
import { ReferenceManager } from "../reference/manager.js";
import { createExposer } from "../policy/expose.js";
import { ExecutionRuntime } from "../runtime/execution.js";
import { registerDeviceTools } from "../tools/device.js";
import { registerFsTools } from "../tools/register-fs.js";
import { registerGitTools } from "../tools/register-git.js";
import { registerReferenceTools } from "../tools/register-reference.js";
import { registerReviewContextTool } from "../tools/register-review-context.js";
import { registerWorkspaceReadTools } from "../tools/register-workspace-read.js";
import {
  WorkspaceManager,
  parseWorkspaceRegistry
} from "../workspace/manager.js";
import {
  loadPersistentWorkspaceEntries,
  mergePersistentWorkspaces
} from "../workspace/persistence.js";

const REVIEW_SCOPE = "p05.review";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type OAuthClient = {
  clientId: string;
  clientSecret: string;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  expiresAt: number;
};

type OAuthToken = {
  expiresAt: number;
};

type PersistedOAuthToken = {
  tokenHash: string;
  expiresAt: number;
};

type PersistedOAuthTokenState = {
  version: 1;
  accessTokens: PersistedOAuthToken[];
  refreshTokens: PersistedOAuthToken[];
};

export type ReviewerHttpServer = {
  host: string;
  port: number;
  url: string;
  profile: "readonly";
  slot: "A" | "B";
  stateDir: string;
  tokenFile: string;
  oauthClientFile: string;
  oauthTokenStateFile: string;
  oauthClientId: string;
  close(): Promise<void>;
};

export type ReviewerHttpServerOptions = {
  host?: string;
  port?: number;
  slot?: "A" | "B";
  stateDir?: string;
  token?: string;
  tokenFile?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthClientFile?: string;
  oauthTokenStateFile?: string;
};

function activeWorkspaceId(stateDir: string): string {
  const filePath = path.join(stateDir, "active-workspace.txt");
  const id = fs.readFileSync(filePath, "utf8").trim();
  if (!id) throw new Error("Reviewer Runtime has no active workspace binding.");
  return id;
}

function workspaceManagerForState(stateDir: string): WorkspaceManager {
  const configured = parseWorkspaceRegistry(
    readOwnEnv("P05_WORKSPACES_JSON"),
    config.allowedRoots,
    config.defaultCwd
  );
  const persistent = loadPersistentWorkspaceEntries(
    path.join(stateDir, "workspaces.json")
  );
  return new WorkspaceManager(
    mergePersistentWorkspaces(
      configured,
      persistent,
      config.allowedRoots,
      config.defaultCwd
    ),
    activeWorkspaceId(stateDir)
  );
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function ensureToken(filePath: string, explicit?: string): string {
  const supplied = explicit?.trim();
  if (supplied) return supplied;

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing.length >= 32) return existing;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(filePath, token + "\n", "utf8");
  return token;
}

function ensureOAuthClient(
  filePath: string,
  explicitId?: string,
  explicitSecret?: string
): OAuthClient {
  const suppliedId = explicitId?.trim();
  const suppliedSecret = explicitSecret?.trim();
  if (suppliedId || suppliedSecret) {
    if (!suppliedId || !suppliedSecret) {
      throw new Error(
        "P05 HTTP Reviewer OAuth client id and secret must be provided together."
      );
    }
    return { clientId: suppliedId, clientSecret: suppliedSecret };
  }

  if (fs.existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      throw new Error("HTTP Reviewer OAuth client file must be valid JSON.");
    }
    const value = parsed as Partial<OAuthClient>;
    if (
      typeof value.clientId === "string" &&
      value.clientId.trim() &&
      typeof value.clientSecret === "string" &&
      value.clientSecret.length >= 32
    ) {
      return {
        clientId: value.clientId,
        clientSecret: value.clientSecret
      };
    }
    throw new Error("HTTP Reviewer OAuth client file is invalid.");
  }

  const client: OAuthClient = {
    clientId: "p05-gemini-reviewer",
    clientSecret: randomBytes(32).toString("base64url")
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(client, null, 2) + "\n",
    "utf8"
  );
  return client;
}

function bearerValue(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const value = header.slice(7).trim();
  return value || undefined;
}

function basicClientCredentials(
  header: string | undefined
): { clientId: string; clientSecret: string } | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1))
    };
  } catch {
    return undefined;
  }
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function oauthTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function loadOAuthTokenState(
  filePath: string
): {
  accessTokens: Map<string, OAuthToken>;
  refreshTokens: Map<string, OAuthToken>;
} {
  const accessTokens = new Map<string, OAuthToken>();
  const refreshTokens = new Map<string, OAuthToken>();
  if (!fs.existsSync(filePath)) return { accessTokens, refreshTokens };

  let parsed: PersistedOAuthTokenState;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedOAuthTokenState;
  } catch {
    throw new Error("HTTP Reviewer OAuth token state must be valid JSON.");
  }
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.accessTokens) ||
    !Array.isArray(parsed.refreshTokens)
  ) {
    throw new Error("HTTP Reviewer OAuth token state is invalid.");
  }

  const now = Date.now();
  for (const entry of parsed.accessTokens) {
    if (
      typeof entry?.tokenHash === "string" &&
      typeof entry?.expiresAt === "number" &&
      entry.expiresAt > now
    ) {
      accessTokens.set(entry.tokenHash, { expiresAt: entry.expiresAt });
    }
  }
  for (const entry of parsed.refreshTokens) {
    if (
      typeof entry?.tokenHash === "string" &&
      typeof entry?.expiresAt === "number" &&
      entry.expiresAt > now
    ) {
      refreshTokens.set(entry.tokenHash, { expiresAt: entry.expiresAt });
    }
  }
  return { accessTokens, refreshTokens };
}

function persistOAuthTokenState(
  filePath: string,
  accessTokens: Map<string, OAuthToken>,
  refreshTokens: Map<string, OAuthToken>
): void {
  const now = Date.now();
  const serialize = (source: Map<string, OAuthToken>) =>
    [...source.entries()]
      .filter(([, value]) => value.expiresAt > now)
      .map(([tokenHash, value]) => ({
        tokenHash,
        expiresAt: value.expiresAt
      }));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state: PersistedOAuthTokenState = {
    version: 1,
    accessTokens: serialize(accessTokens),
    refreshTokens: serialize(refreshTokens)
  };
  const tempPath = filePath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

function externalBaseUrl(
  request: http.IncomingMessage,
  host: string,
  port: number
): string {
  const explicit = readOwnEnv("P05_HTTP_REVIEWER_PUBLIC_BASE_URL")?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const forwardedProto = String(
    request.headers["x-forwarded-proto"] ?? ""
  ).split(",")[0]!.trim();
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : "http";
  const forwardedHost = String(
    request.headers["x-forwarded-host"] ?? ""
  ).split(",")[0]!.trim();
  const hostHeader = forwardedHost || request.headers.host;
  return `${proto}://${hostHeader || `${host}:${port}`}`;
}

function oauthProtectedResourceMetadata(base: string) {
  return {
    resource: base + "/mcp",
    authorization_servers: [base],
    scopes_supported: [REVIEW_SCOPE],
    bearer_methods_supported: ["header"]
  };
}

function oauthAuthorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: base + "/authorize",
    token_endpoint: base + "/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post"
    ],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [REVIEW_SCOPE]
  };
}

function json(
  response: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function redirect(response: http.ServerResponse, target: string): void {
  response.writeHead(302, {
    location: target,
    "cache-control": "no-store"
  });
  response.end();
}

async function readBody(
  request: http.IncomingMessage,
  maxBytes = 64 * 1024
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("HTTP request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function formBody(
  request: http.IncomingMessage
): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(request)).toString("utf8"));
}

function validateClient(
  request: http.IncomingMessage,
  form: URLSearchParams,
  expected: OAuthClient
): boolean {
  const basic = basicClientCredentials(request.headers.authorization);
  const clientId = basic?.clientId ?? form.get("client_id") ?? "";
  const clientSecret =
    basic?.clientSecret ?? form.get("client_secret") ?? "";
  return (
    constantTimeEqual(clientId, expected.clientId) &&
    constantTimeEqual(clientSecret, expected.clientSecret)
  );
}

async function webRequestFromNode(
  request: http.IncomingMessage,
  host: string,
  port: number
): Promise<Request> {
  const body = await readBody(request, 2 * 1024 * 1024);

  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else if (raw !== undefined) {
      headers.set(name, raw);
    }
  }

  return new Request(
    `http://${host}:${port}${request.url ?? "/"}`,
    {
      method: request.method ?? "GET",
      headers,
      ...(body.length
        ? { body: body as unknown as BodyInit }
        : {})
    }
  );
}

async function sendWebResponse(
  response: Response,
  nodeResponse: http.ServerResponse
): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => {
    nodeResponse.setHeader(name, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const source = Readable.fromWeb(response.body as any);
    source.once("error", reject);
    nodeResponse.once("error", reject);
    nodeResponse.once("finish", resolve);
    source.pipe(nodeResponse);
  });
}

export async function startReviewerHttpServer(
  options: ReviewerHttpServerOptions = {}
): Promise<ReviewerHttpServer> {
  const slot = options.slot ?? "B";
  const stateDir = path.resolve(
    options.stateDir ??
      path.join(process.cwd(), ".p05", `runtime-${slot.toLowerCase()}`, "state")
  );
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? Number(
    readOwnEnv("P05_HTTP_REVIEWER_PORT") ?? "8765"
  );
  const tokenFile = path.resolve(
    options.tokenFile ?? path.join(stateDir, "http-reviewer-token.txt")
  );
  const oauthClientFile = path.resolve(
    options.oauthClientFile ??
      path.join(stateDir, "http-reviewer-oauth-client.json")
  );
  const token = ensureToken(
    tokenFile,
    options.token ?? readOwnEnv("P05_HTTP_REVIEWER_TOKEN")
  );
  const oauthTokenStateFile = path.resolve(
    options.oauthTokenStateFile ??
      path.join(stateDir, "http-reviewer-oauth-tokens.json")
  );
  const oauthClient = ensureOAuthClient(
    oauthClientFile,
    options.oauthClientId ?? readOwnEnv("P05_HTTP_REVIEWER_OAUTH_CLIENT_ID"),
    options.oauthClientSecret ??
      readOwnEnv("P05_HTTP_REVIEWER_OAUTH_CLIENT_SECRET")
  );

  workspaceManagerForState(stateDir);

  const authorizationCodes = new Map<string, AuthorizationCode>();
  const {
    accessTokens,
    refreshTokens
  } = loadOAuthTokenState(oauthTokenStateFile);
  persistOAuthTokenState(oauthTokenStateFile, accessTokens, refreshTokens);

  const catalog = new CapabilityCatalog();
  catalog.registerMany([
    {
      name: "review_context",
      minProfile: "readonly",
      risk: "read",
      scope: "platform",
      summary: "Return a fresh reviewer snapshot of the current workspace, Git state, reference roots and immutable reviewer authority."
    }
  ], "http-reviewer");
  const auditStore = new AuditStore(
    200,
    path.join(stateDir, "http-reviewer-audit.json")
  );
  const liveActivity = new LiveActivityStore(200);

  const handler = createMcpHandler(async () => {
    const workspaceManager = workspaceManagerForState(stateDir);
    const referenceManager = new ReferenceManager(
      path.join(stateDir, "references.json")
    );
    const server = new McpServer(
      {
        name: "p05-http-reviewer",
        version: config.version
      },
      {
        instructions: [
          "You are connected to P05 HTTP Reviewer, a strictly read-only engineering review surface.",
          "Before answering any question about the current repository, workspace, Git branch, files, diffs, or review status, call review_context and treat that result as the fresh source of truth.",
          "Do not reuse workspace, branch, file-status or repository-state facts from conversation history when a fresh tool call is available.",
          "workspace_list and workspace_current are read-only inspection tools. They cannot switch, bind, authorize, or modify a workspace.",
          "You cannot stop, start, restart, or otherwise control Runtime A or Runtime B.",
          "You cannot write files, execute shell commands, mutate Git, authorize Reference Roots, switch workspaces, or invoke downstream/MATLAB tools.",
          "If asked to perform an unavailable control or mutation, state that the Reviewer does not have that capability instead of implying that it was performed."
        ].join("\n")
      }
    );
    const runtime = new ExecutionRuntime(
      auditStore,
      () => workspaceManager.current().id,
      catalog,
      liveActivity,
      {
        source: "http-reviewer",
        transport: "streamable-http",
        runtimeSlot: slot,
        principal: "p05-reviewer"
      }
    );
    const exposer = createExposer(
      server,
      "readonly",
      "env",
      runtime,
      catalog
    );

    registerDeviceTools(exposer);
    registerWorkspaceReadTools(exposer, workspaceManager);
    registerReviewContextTool(exposer, workspaceManager, referenceManager, slot);
    registerFsTools(exposer, workspaceManager);
    registerGitTools(exposer, workspaceManager);
    registerReferenceTools(exposer, referenceManager);

    return server;
  });

  const isMcpAuthorized = (header: string | undefined): boolean => {
    const value = bearerValue(header);
    if (!value) return false;
    if (constantTimeEqual(value, token)) return true;
    const tokenHash = oauthTokenHash(value);
    const record = accessTokens.get(tokenHash);
    if (!record) return false;
    if (record.expiresAt <= Date.now()) {
      accessTokens.delete(tokenHash);
      persistOAuthTokenState(
        oauthTokenStateFile,
        accessTokens,
        refreshTokens
      );
      return false;
    }
    return true;
  };

  const issueTokens = () => {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    accessTokens.set(oauthTokenHash(accessToken), {
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS
    });
    refreshTokens.set(oauthTokenHash(refreshToken), {
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS
    });
    persistOAuthTokenState(
      oauthTokenStateFile,
      accessTokens,
      refreshTokens
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: REVIEW_SCOPE
    };
  };

  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const actualPort =
        address && typeof address !== "string"
          ? address.port
          : requestedPort;
      const url = new URL(
        request.url ?? "/",
        `http://${host}:${actualPort || 80}`
      );
      const base = externalBaseUrl(request, host, actualPort);

      if (request.method === "GET" && url.pathname === "/healthz") {
        const workspaceManager = workspaceManagerForState(stateDir);
        json(response, 200, {
          status: "ok",
          name: "p05-http-reviewer",
          slot,
          profile: "readonly",
          workspace: workspaceManager.current().id,
          oauth: true
        });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        json(response, 200, oauthProtectedResourceMetadata(base));
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        json(response, 200, oauthAuthorizationServerMetadata(base));
        return;
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        const responseType = url.searchParams.get("response_type");
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state");
        const scope = url.searchParams.get("scope") ?? REVIEW_SCOPE;
        const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
        const codeChallengeMethod =
          url.searchParams.get("code_challenge_method") ?? undefined;

        if (responseType !== "code") {
          json(response, 400, { error: "unsupported_response_type" });
          return;
        }
        if (!constantTimeEqual(clientId, oauthClient.clientId)) {
          json(response, 400, { error: "invalid_client" });
          return;
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(redirectUri);
        } catch {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        if (
          redirectUrl.protocol !== "https:" &&
          !(redirectUrl.protocol === "http:" &&
            (redirectUrl.hostname === "127.0.0.1" ||
              redirectUrl.hostname === "localhost"))
        ) {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        if (scope.split(/\s+/).some((item) => item && item !== REVIEW_SCOPE)) {
          redirectUrl.searchParams.set("error", "invalid_scope");
          if (state) redirectUrl.searchParams.set("state", state);
          redirect(response, redirectUrl.toString());
          return;
        }
        if (
          codeChallenge &&
          codeChallengeMethod &&
          codeChallengeMethod !== "S256"
        ) {
          redirectUrl.searchParams.set("error", "invalid_request");
          if (state) redirectUrl.searchParams.set("state", state);
          redirect(response, redirectUrl.toString());
          return;
        }

        const code = randomBytes(32).toString("base64url");
        authorizationCodes.set(code, {
          clientId,
          redirectUri: redirectUrl.toString(),
          ...(codeChallenge ? { codeChallenge } : {}),
          expiresAt: Date.now() + AUTH_CODE_TTL_MS
        });
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);
        redirect(response, redirectUrl.toString());
        return;
      }

      if (request.method === "POST" && url.pathname === "/token") {
        const form = await formBody(request);
        if (!validateClient(request, form, oauthClient)) {
          json(
            response,
            401,
            { error: "invalid_client" },
            { "www-authenticate": 'Basic realm="p05-http-reviewer"' }
          );
          return;
        }

        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
          const code = form.get("code") ?? "";
          const redirectUri = form.get("redirect_uri") ?? "";
          const record = authorizationCodes.get(code);
          authorizationCodes.delete(code);
          if (
            !record ||
            record.expiresAt <= Date.now() ||
            !constantTimeEqual(record.clientId, oauthClient.clientId) ||
            record.redirectUri !== redirectUri
          ) {
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          if (record.codeChallenge) {
            const verifier = form.get("code_verifier") ?? "";
            if (
              !verifier ||
              !constantTimeEqual(pkceS256(verifier), record.codeChallenge)
            ) {
              json(response, 400, { error: "invalid_grant" });
              return;
            }
          }
          json(response, 200, issueTokens());
          return;
        }

        if (grantType === "refresh_token") {
          const refreshToken = form.get("refresh_token") ?? "";
          const refreshTokenHash = oauthTokenHash(refreshToken);
          const record = refreshTokens.get(refreshTokenHash);
          refreshTokens.delete(refreshTokenHash);
          persistOAuthTokenState(
            oauthTokenStateFile,
            accessTokens,
            refreshTokens
          );
          if (!record || record.expiresAt <= Date.now()) {
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          json(response, 200, issueTokens());
          return;
        }

        json(response, 400, { error: "unsupported_grant_type" });
        return;
      }

      if (url.pathname !== "/mcp") {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end("not found");
        return;
      }

      if (!isMcpAuthorized(request.headers.authorization)) {
        const resourceMetadata =
          base + "/.well-known/oauth-protected-resource/mcp";
        json(
          response,
          401,
          { error: "unauthorized" },
          {
            "www-authenticate":
              `Bearer realm="p05-http-reviewer", scope="${REVIEW_SCOPE}", resource_metadata="${resourceMetadata}"`
          }
        );
        return;
      }

      const webRequest = await webRequestFromNode(
        request,
        host,
        actualPort
      );
      const webResponse = await handler.fetch(webRequest);
      await sendWebResponse(webResponse, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(
          error instanceof Error ? error : new Error(String(error))
        );
        return;
      }
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("HTTP Reviewer did not obtain a TCP address.");
  }

  const url = `http://${host}:${address.port}/mcp`;
  return {
    host,
    port: address.port,
    url,
    profile: "readonly",
    slot,
    stateDir,
    tokenFile,
    oauthClientFile,
    oauthTokenStateFile,
    oauthClientId: oauthClient.clientId,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
