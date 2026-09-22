import http from "node:http";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { AuditStore } from "../audit/store.js";
import type { CapabilityCatalog } from "../capability/registry.js";
import { getDeviceInfo } from "../device/identity.js";
import type { DownstreamRegistry } from "../downstream/registry.js";
import type { LiveActivityStore } from "../monitor/live-activity.js";
import type { PluginRuntime } from "../plugin/runtime.js";
import type { ReferenceManager } from "../reference/manager.js";
import type { ToolProfileReport } from "../policy/tool-profile.js";
import { p05StatePath } from "../state.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspaceDescriptor } from "../workspace/types.js";

export type LocalControlBridge = {
  url: string;
  close(): Promise<void>;
};

type BridgeDeps = {
  workspaceManager: WorkspaceManager;
  referenceManager: ReferenceManager;
  auditStore: AuditStore;
  pluginRuntime: PluginRuntime;
  downstreamRegistry: DownstreamRegistry;
  capabilityCatalog: CapabilityCatalog;
  liveActivity: LiveActivityStore;
  exposure: () => ToolProfileReport;
  profile: string;
  profileSource: string;
  persistWorkspace?: (workspace: WorkspaceDescriptor) => void;
  metadataPath?: string;
  port?: number;
};

function json(
  response: http.ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function bodyJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export async function startLocalControlBridge(
  deps: BridgeDeps
): Promise<LocalControlBridge> {
  const token = randomBytes(32).toString("hex");
  const metadataPath =
    deps.metadataPath ?? p05StatePath(`operator-bridge-${process.pid}.json`);
  const startedAt = new Date().toISOString();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/overview") {
        const current = deps.workspaceManager.current();
        json(response, 200, {
          online: true,
          startedAt,
          device: getDeviceInfo(),
          mcp: {
            profile: deps.profile,
            profileSource: deps.profileSource,
            exposure: deps.exposure(),
            capabilities: deps.capabilityCatalog.list()
          },
          workspace: {
            current: {
              id: current.id,
              root: current.root,
              kind: current.kind,
              label: current.label ?? current.id,
              plugins: current.plugins ?? [],
              authorization: { ...current.authorization }
            },
            all: deps.workspaceManager.list().map((view) => ({
              ...view,
              root: deps.workspaceManager.get(view.id).root
            }))
          },
          references: deps.referenceManager.localList(),
          plugins: deps.pluginRuntime.list(),
          downstream: deps.downstreamRegistry.statuses(),
          activity: deps.auditStore.recent(60),
          liveActivity: deps.liveActivity.recent(80),
          recovery: deps.auditStore.recovery(30)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspaces") {
        const workspaces = deps.workspaceManager.list().map((view) => ({
          ...view,
          root: deps.workspaceManager.get(view.id).root
        }));
        json(response, 200, { workspaces });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/select") {
        const payload = await bodyJson(request);
        const id = typeof payload.id === "string" ? payload.id.trim() : "";
        if (!id) throw new Error("Workspace id is required.");
        const selected = deps.workspaceManager.switch(id);
        const current = deps.workspaceManager.current();
        json(response, 200, {
          workspace: {
            ...selected,
            root: current.root
          }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/root") {
        const payload = await bodyJson(request);
        const root = typeof payload.root === "string" ? payload.root.trim() : "";
        if (!root) throw new Error("Workspace root is required.");
        const selected = deps.workspaceManager.setSessionRoot(root);
        const current = deps.workspaceManager.current();
        json(response, 200, {
          workspace: {
            ...selected,
            root: current.root
          }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/register") {
        if (!deps.persistWorkspace) {
          throw new Error("Persistent workspace registration is unavailable.");
        }
        const candidate = deps.workspaceManager.persistentRegistrationCandidate();
        deps.persistWorkspace(candidate);
        const registered = deps.workspaceManager.registerPersistentWorkspace(candidate);
        const current = deps.workspaceManager.current();
        json(response, 200, {
          workspace: {
            ...registered,
            root: current.root
          }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/references") {
        json(response, 200, { references: deps.referenceManager.localList() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reference/root") {
        const payload = await bodyJson(request);
        const root = typeof payload.root === "string" ? payload.root.trim() : "";
        if (!root) throw new Error("Reference root is required.");
        const reference = deps.referenceManager.add(root);
        json(response, 200, { reference });
        return;
      }

      const referenceRemoveMatch = url.pathname.match(
        /^\/api\/reference\/([a-z0-9][a-z0-9._-]{0,63})\/remove$/
      );
      if (request.method === "POST" && referenceRemoveMatch) {
        const reference = deps.referenceManager.remove(referenceRemoveMatch[1]!);
        json(response, 200, { reference });
        return;
      }

      const pluginActionMatch = url.pathname.match(
        /^\/api\/plugin\/([a-z0-9][a-z0-9._-]{0,63})\/action\/(start|stop)$/
      );
      if (request.method === "POST" && pluginActionMatch) {
        const pluginId = pluginActionMatch[1]!;
        const action = pluginActionMatch[2]!;
        const plugin =
          action === "start"
            ? await deps.pluginRuntime.start(pluginId)
            : await deps.pluginRuntime.stop(pluginId, deps.downstreamRegistry);
        json(response, 200, { plugin });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/activity") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? "60") || 60, 1),
          100
        );
        json(response, 200, { events: deps.auditStore.recent(limit) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/live-activity") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? "80") || 80, 1),
          200
        );
        json(response, 200, { events: deps.liveActivity.recent(limit) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/recovery") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? "30") || 30, 1),
          100
        );
        json(response, 200, { events: deps.auditStore.recovery(limit) });
        return;
      }

      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local control bridge did not obtain a TCP address.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      version: 1,
      url,
      token,
      pid: process.pid,
      startedAt
    }, null, 2) + "\n",
    "utf8"
  );

  return {
    url,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
          pid?: number;
        };
        if (current.pid === process.pid) fs.unlinkSync(metadataPath);
      } catch {
        // Best effort cleanup only.
      }
    }
  };
}
