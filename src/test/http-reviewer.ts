/**
 * Native Streamable HTTP Reviewer end-to-end verification.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const entry = path.resolve(here, "..", "http-reviewer.js");
const fixture = path.join(repo, "_p05_http_reviewer_test");
const workspace = path.join(fixture, "workspace");
const workspace2 = path.join(fixture, "workspace-2");
const stateDir = path.join(fixture, "state");
const token = "p05-http-reviewer-test-token-00000000000000000000000000000000";
const oauthClientId = "p05-gemini-reviewer-test";
const oauthClientSecret = "p05-reviewer-test-secret-00000000000000000000000000000000";

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

const envExample = await fs.readFile(path.join(repo, ".env.example"), "utf8");
const reviewerConfigSources = (
  await Promise.all([
    fs.readFile(path.join(repo, "src", "http-reviewer.ts"), "utf8"),
    fs.readFile(path.join(repo, "src", "http", "reviewer.ts"), "utf8")
  ])
).join("\n");
const reviewerEnvNames = [
  ...new Set(
    [...reviewerConfigSources.matchAll(/P05_HTTP_REVIEWER_[A-Z_]+/g)]
      .map((match) => match[0])
  )
].sort();

check(
  "http reviewer: every implemented environment variable is documented in .env.example",
  reviewerEnvNames.length > 0 &&
    reviewerEnvNames.every((name) => envExample.includes(name + "=")),
  reviewerEnvNames.filter((name) => !envExample.includes(name + "=")).join(", ")
);
check(
  "http reviewer: .env.example does not enable reviewer secrets",
  !envExample.split(/\r?\n/).some((line) =>
    /^P05_HTTP_REVIEWER_(TOKEN|OAUTH_CLIENT_SECRET)=/.test(line.trim())
  )
);

async function waitForReady(
  stderr: NodeJS.ReadableStream,
  timeoutMs = 15_000
): Promise<{ url: string }> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("HTTP reviewer did not become ready.")),
      timeoutMs
    );

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { event?: string; url?: string };
          if (event.event === "p05.http_reviewer_ready" && event.url) {
            clearTimeout(timer);
            stderr.off("data", onData);
            resolve({ url: event.url });
            return;
          }
        } catch {
          // Ignore non-readiness stderr lines.
        }
      }
    };

    stderr.on("data", onData);
  });
}

await fs.rm(fixture, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(workspace2, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(path.join(workspace, "review.txt"), "review-ok\n", "utf8");
await fs.writeFile(path.join(stateDir, "active-workspace.txt"), "review-project\n", "utf8");
await fs.writeFile(
  path.join(stateDir, "workspaces.json"),
  JSON.stringify({
    version: 1,
    workspaces: [
      {
        id: "review-project",
        root: workspace,
        kind: "git-project",
        label: "Review Project"
      },
      {
        id: "review-project-2",
        root: workspace2,
        kind: "git-project",
        label: "Review Project 2"
      }
    ]
  }, null, 2) + "\n",
  "utf8"
);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string" && !key.startsWith("P05_")) env[key] = value;
}
env.REMOTE_AGENT_ALLOWED_ROOTS = repo;
env.REMOTE_AGENT_DEFAULT_CWD = repo;
env.P05_WORKSPACES_JSON = JSON.stringify([{
  id: "platform",
  root: repo,
  kind: "platform-source",
  label: "P05"
}]);
env.P05_HTTP_REVIEWER_SLOT = "B";
env.P05_HTTP_REVIEWER_STATE_DIR = stateDir;
env.P05_HTTP_REVIEWER_PORT = "0";
env.P05_HTTP_REVIEWER_TOKEN = token;
env.P05_HTTP_REVIEWER_OAUTH_CLIENT_ID = oauthClientId;
env.P05_HTTP_REVIEWER_OAUTH_CLIENT_SECRET = oauthClientSecret;

const child = spawn(process.execPath, [entry], {
  cwd: repo,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  const ready = await waitForReady(child.stderr!);

  const unauthenticated = await fetch(ready.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check(
    "http reviewer: bearer token is mandatory",
    unauthenticated.status === 401,
    String(unauthenticated.status)
  );
  check(
    "http reviewer: MCP 401 advertises OAuth resource metadata",
    (unauthenticated.headers.get("www-authenticate") ?? "")
      .includes("resource_metadata=")
  );

  const base = new URL(ready.url).origin;
  const protectedMetadata = await fetch(
    base + "/.well-known/oauth-protected-resource/mcp"
  ).then((response) => response.json()) as {
    resource?: string;
    authorization_servers?: string[];
    scopes_supported?: string[];
  };
  check(
    "http reviewer: OAuth protected resource metadata points to MCP",
    protectedMetadata.resource === ready.url &&
    protectedMetadata.authorization_servers?.[0] === base &&
    protectedMetadata.scopes_supported?.includes("p05.review") === true,
    JSON.stringify(protectedMetadata)
  );

  const authorizationMetadata = await fetch(
    base + "/.well-known/oauth-authorization-server"
  ).then((response) => response.json()) as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    code_challenge_methods_supported?: string[];
  };
  check(
    "http reviewer: OAuth authorization server metadata is complete",
    authorizationMetadata.issuer === base &&
    authorizationMetadata.authorization_endpoint === base + "/authorize" &&
    authorizationMetadata.token_endpoint === base + "/token" &&
    authorizationMetadata.code_challenge_methods_supported?.includes("S256") === true,
    JSON.stringify(authorizationMetadata)
  );

  const verifier = "p05-reviewer-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  const redirectUri = "https://client.example/callback";
  const authorize = new URL(base + "/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", oauthClientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "p05.review");
  authorize.searchParams.set("state", "state-123");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await fetch(authorize, { redirect: "manual" });
  const location = authorizeResponse.headers.get("location") ?? "";
  const redirected = new URL(location);
  const code = redirected.searchParams.get("code") ?? "";
  check(
    "http reviewer: OAuth authorize issues a code and preserves state",
    authorizeResponse.status === 302 &&
    code.length > 20 &&
    redirected.searchParams.get("state") === "state-123",
    location
  );

  const tokenResponse = await fetch(base + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      code_verifier: verifier
    })
  });
  const oauthTokens = await tokenResponse.json() as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
  };
  check(
    "http reviewer: OAuth token exchange succeeds",
    tokenResponse.status === 200 &&
    (oauthTokens.access_token?.length ?? 0) > 20 &&
    (oauthTokens.refresh_token?.length ?? 0) > 20 &&
    oauthTokens.token_type === "Bearer" &&
    oauthTokens.scope === "p05.review",
    JSON.stringify({
      status: tokenResponse.status,
      token_type: oauthTokens.token_type,
      scope: oauthTokens.scope
    })
  );

  const refreshResponse = await fetch(base + "/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(
        oauthClientId + ":" + oauthClientSecret,
        "utf8"
      ).toString("base64")
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauthTokens.refresh_token ?? ""
    })
  });
  const refreshed = await refreshResponse.json() as {
    access_token?: string;
  };
  check(
    "http reviewer: OAuth refresh token flow succeeds",
    refreshResponse.status === 200 &&
    (refreshed.access_token?.length ?? 0) > 20
  );

  const client = new Client({ name: "p05-http-reviewer-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ready.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${oauthTokens.access_token}` }
    }
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const expected of [
      "device_info",
      "ping",
      "workspace_list",
      "workspace_current",
      "review_context",
      "fs_read",
      "fs_list",
      "git_status",
      "git_diff",
      "git_diff_stat",
      "reference_list",
      "reference_read",
      "reference_list_directory"
    ]) {
      check(
        `http reviewer: exposes ${expected}`,
        names.includes(expected),
        names.join(",")
      );
    }

    for (const tool of tools) {
      check(
        `http reviewer: ${tool.name} declares read-only MCP annotations`,
        tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint === false &&
          tool.annotations?.idempotentHint === true &&
          tool.annotations?.openWorldHint === false,
        JSON.stringify(tool.annotations ?? null)
      );
    }

    for (const forbidden of [
      "fs_write",
      "apply_patch",
      "shell_run",
      "command_run",
      "workspace_switch",
      "matlab.call_tool",
      "mcp_call_tool",
      "git_commit",
      "git_push"
    ]) {
      check(
        `http reviewer: suppresses ${forbidden}`,
        !names.includes(forbidden),
        names.join(",")
      );
    }

    const current = await client.callTool({
      name: "workspace_current",
      arguments: {}
    });
    const currentData = current.structuredContent as { id?: string };
    check(
      "http reviewer: follows the Runtime slot workspace binding",
      currentData?.id === "review-project",
      JSON.stringify(currentData)
    );

    const reviewContext = await client.callTool({
      name: "review_context",
      arguments: {}
    });
    const reviewData = reviewContext.structuredContent as {
      workspace?: { id?: string };
      authority?: {
        canSwitchWorkspace?: boolean;
        canControlRuntime?: boolean;
        canWrite?: boolean;
        canExecuteShell?: boolean;
      };
    };
    check(
      "http reviewer: review_context returns the fresh workspace binding",
      reviewData?.workspace?.id === "review-project",
      JSON.stringify(reviewData)
    );
    check(
      "http reviewer: review_context declares immutable reviewer authority",
      reviewData?.authority?.canSwitchWorkspace === false &&
        reviewData?.authority?.canControlRuntime === false &&
        reviewData?.authority?.canWrite === false &&
        reviewData?.authority?.canExecuteShell === false,
      JSON.stringify(reviewData?.authority)
    );

    const read = await client.callTool({
      name: "fs_read",
      arguments: { path: "review.txt" }
    });
    const readData = read.structuredContent as { text?: string };
    check(
      "http reviewer: can read the bound workspace",
      readData?.text?.includes("review-ok") === true,
      JSON.stringify(readData)
    );

    await fs.writeFile(
      path.join(stateDir, "active-workspace.txt"),
      "review-project-2\n",
      "utf8"
    );
    const rebound = await client.callTool({
      name: "workspace_current",
      arguments: {}
    });
    const reboundData = rebound.structuredContent as { id?: string };
    check(
      "http reviewer: follows local Runtime workspace rebinding without restart",
      reboundData?.id === "review-project-2",
      JSON.stringify(reboundData)
    );

    const reboundContext = await client.callTool({
      name: "review_context",
      arguments: {}
    });
    const reboundContextData = reboundContext.structuredContent as {
      workspace?: { id?: string };
    };
    check(
      "http reviewer: review_context refreshes after local workspace rebinding",
      reboundContextData?.workspace?.id === "review-project-2",
      JSON.stringify(reboundContextData)
    );

    let refused = false;
    try {
      await client.callTool({
        name: "fs_write",
        arguments: { path: "must-not-land.txt", content: "x" }
      });
    } catch {
      refused = true;
    }
    check("http reviewer: unexposed writes are uncallable", refused);
    check(
      "http reviewer: rejected write created no file",
      await fs.access(path.join(workspace, "must-not-land.txt"))
        .then(() => false)
        .catch(() => true)
    );

    const reviewerAudit = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "http-reviewer-audit.json"),
        "utf8"
      )
    ) as {
      events?: Array<{
        capability?: string;
        source?: string;
        transport?: string;
        runtimeSlot?: string;
        principal?: string;
        clientName?: string;
        clientVersion?: string;
      }>;
    };
    const attributedEvent = reviewerAudit.events
      ?.slice()
      .reverse()
      .find((event) => event.capability === "review_context");
    check(
      "http reviewer: audit records reviewer source, transport, slot and principal",
      attributedEvent?.source === "http-reviewer" &&
        attributedEvent?.transport === "streamable-http" &&
        attributedEvent?.runtimeSlot === "B" &&
        attributedEvent?.principal === "p05-reviewer",
      JSON.stringify(attributedEvent)
    );
    check(
      "http reviewer: optional client identity is display metadata only",
      attributedEvent?.clientName === undefined ||
        typeof attributedEvent.clientName === "string",
      JSON.stringify(attributedEvent)
    );
  } finally {
    await client.close();
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 3000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const restartedChild = spawn(process.execPath, [entry], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const restartedReady = await waitForReady(restartedChild.stderr!);
    const restartedClient = new Client({
      name: "p05-http-reviewer-restart-test",
      version: "1.0.0"
    });
    const restartedTransport = new StreamableHTTPClientTransport(
      new URL(restartedReady.url),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${oauthTokens.access_token}`
          }
        }
      }
    );
    try {
      await restartedClient.connect(restartedTransport);
      const afterRestart = await restartedClient.callTool({
        name: "review_context",
        arguments: {}
      });
      const afterRestartData = afterRestart.structuredContent as {
        workspace?: { id?: string };
      };
      check(
        "http reviewer: OAuth access token survives Reviewer restart",
        afterRestartData?.workspace?.id === "review-project-2",
        JSON.stringify(afterRestartData)
      );
    } finally {
      await restartedClient.close();
    }
  } finally {
    restartedChild.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (restartedChild.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 3000);
      restartedChild.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fs.rm(fixture, { recursive: true, force: true });
}

console.log(`HTTP_REVIEWER_OK (${checks} checks)`);
