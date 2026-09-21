import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import type {
  DownstreamDefinition,
  DownstreamWorkspaceBinding
} from "../../downstream/types.js";
import { PLUGIN_API_VERSION, type ApplicationPlugin } from "../../plugin/types.js";
import { structuredResult } from "../../tools/result.js";
import { MatlabSkillCatalog } from "./skills.js";

export type MatlabToolkitDiscovery = {
  root: string;
  command?: string;
  simulinkExtension?: string;
};

function parseArgs(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("MATLAB_MCP_ARGS_JSON must be a JSON array of strings.");
  }
  return value;
}

function parseWorkspaceBinding(): DownstreamWorkspaceBinding {
  const raw = process.env.MATLAB_MCP_WORKSPACE_BINDING?.trim().toLowerCase();
  if (!raw) return process.env.MATLAB_MCP_CWD?.trim() ? "fixed" : "active";
  if (raw === "active" || raw === "platform" || raw === "fixed") return raw;
  throw new Error("MATLAB_MCP_WORKSPACE_BINDING must be active, platform or fixed.");
}

function parseRequestTimeoutMs(): number {
  const raw = process.env.MATLAB_MCP_TIMEOUT_MS?.trim();
  if (!raw) return 600_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000) {
    throw new Error("MATLAB_MCP_TIMEOUT_MS must be a finite number of milliseconds >= 1000.");
  }
  return Math.floor(value);
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function existingFile(candidate: string): string | undefined {
  try {
    return fs.statSync(candidate).isFile() ? path.resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

export function discoverMatlabAgenticToolkit(
  toolkitRoot = process.env.MATLAB_AGENTIC_TOOLKIT_ROOT?.trim() ||
    path.join(os.homedir(), ".matlab", "agentic-toolkits")
): MatlabToolkitDiscovery {
  const root = path.resolve(toolkitRoot);
  const bin = path.join(root, "bin");
  const commandCandidates = process.platform === "win32"
    ? [
        path.join(bin, "matlab-mcp-server.exe"),
        path.join(bin, "matlab-mcp-server-windows-x64.exe")
      ]
    : [
        path.join(bin, "matlab-mcp-server"),
        path.join(bin, "matlab-mcp-server-linux-x64"),
        path.join(bin, "matlab-mcp-server-macos-arm64")
      ];

  const command = commandCandidates
    .map(existingFile)
    .find((candidate): candidate is string => Boolean(candidate));
  const simulinkExtension = existingFile(
    path.join(root, "simulink", "tools", "tools.json")
  );

  return {
    root,
    ...(command ? { command } : {}),
    ...(simulinkExtension ? { simulinkExtension } : {})
  };
}

function buildMatlabArgs(discovery: MatlabToolkitDiscovery): string[] {
  const args = [...parseArgs(process.env.MATLAB_MCP_ARGS_JSON)];

  if (!args.some((arg) => arg.startsWith("--matlab-session-mode="))) {
    args.push("--matlab-session-mode=auto");
  }

  if (
    envFlag("MATLAB_MCP_AUTO_SIMULINK", true) &&
    discovery.simulinkExtension &&
    !args.some((arg) => {
      if (!arg.startsWith("--extension-file=")) return false;
      const configured = arg.slice("--extension-file=".length).replace(/^["']|["']$/g, "");
      return path.resolve(configured).toLowerCase() === discovery.simulinkExtension!.toLowerCase();
    })
  ) {
    args.push(`--extension-file=${discovery.simulinkExtension}`);
  }

  return args;
}

function windowsRootEnv(): Record<string, string> {
  const root = process.env.WINDIR ?? process.env.SystemRoot;
  return root ? { WINDIR: root } : {};
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function insideWorkspace(candidate: string, workspaceRoot: string): boolean {
  const value = normalizeForCompare(candidate);
  const root = normalizeForCompare(workspaceRoot);
  return value === root || value.startsWith(root + path.sep);
}

function canonicalCandidate(resolved: string): string {
  let current = resolved;
  const pending: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pending.unshift(path.basename(current));
    current = parent;
  }

  try {
    return path.join(fs.realpathSync(current), ...pending);
  } catch {
    return resolved;
  }
}

function checkedWorkspacePath(input: string, workspaceRoot: string, field: string): string {
  const resolved = path.resolve(workspaceRoot, input);
  if (!insideWorkspace(resolved, workspaceRoot)) {
    throw new Error(`MATLAB argument "${field}" is outside the active workspace.`);
  }

  const canonical = canonicalCandidate(resolved);
  if (!insideWorkspace(canonical, workspaceRoot)) {
    throw new Error(`MATLAB argument "${field}" resolves outside the active workspace.`);
  }
  return resolved;
}

function isWorkspacePathField(key: string): boolean {
  return key === "model" || key.endsWith("_path");
}

export function guardMatlabWorkspaceArguments(
  args: Record<string, unknown>,
  workspaceRoot: string
): Record<string, unknown> {
  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === "string" && key && isWorkspacePathField(key)) {
      const resolved = checkedWorkspacePath(value, workspaceRoot, key);
      return key.endsWith("_path") ? resolved : value;
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          visit(childValue, childKey)
        ])
      );
    }
    return value;
  };

  return visit(args) as Record<string, unknown>;
}

export function createMatlabDownstreamDefinition(): DownstreamDefinition {
  const binding = parseWorkspaceBinding();
  const fixedCwd = process.env.MATLAB_MCP_CWD?.trim();
  const discovery = discoverMatlabAgenticToolkit();
  const explicitCommand = process.env.MATLAB_MCP_COMMAND?.trim();
  const command = explicitCommand || discovery.command;

  if (binding === "fixed" && !fixedCwd) {
    throw new Error("MATLAB_MCP_CWD is required when MATLAB_MCP_WORKSPACE_BINDING=fixed.");
  }

  return {
    id: "matlab",
    label: "MathWorks MATLAB MCP Server",
    enabled: (process.env.MATLAB_MCP_ENABLED ?? "false").toLowerCase() === "true",
    ...(command ? { command } : {}),
    args: buildMatlabArgs(discovery),
    workspaceBinding: binding,
    ...(binding === "fixed" && fixedCwd ? { cwd: fixedCwd } : {}),
    env: windowsRootEnv(),
    requestTimeoutMs: parseRequestTimeoutMs()
  };
}

export const matlabPlugin: ApplicationPlugin = {
  manifest: {
    id: "matlab",
    label: "MATLAB / Simulink",
    version: "2.1.0",
    apiVersion: PLUGIN_API_VERSION,
    enabled: (process.env.MATLAB_MCP_ENABLED ?? "false").toLowerCase() === "true",
    capabilities: [
      {
        name: "matlab.call_tool",
        minProfile: "developer",
        risk: "execute",
        scope: "downstream",
        summary: "Call one tool on the configured MATLAB MCP server for the active workspace."
      },
      {
        name: "matlab.skill_list",
        minProfile: "readonly",
        risk: "read",
        scope: "platform",
        summary: "List installed MathWorks MATLAB/Simulink Agentic Toolkit skill assets."
      },
      {
        name: "matlab.skill_read",
        minProfile: "readonly",
        risk: "read",
        scope: "platform",
        summary: "Read one installed MathWorks MATLAB/Simulink Agentic Toolkit skill asset by id."
      }
    ],
    permissions: {
      workspace: parseWorkspaceBinding(),
      hostEffects: "none"
    }
  },
  downstreamDefinitions: () => [createMatlabDownstreamDefinition()],
  registerTools: (exposer, context) => {
    const downstream = context.downstreamRegistry;
    if (!downstream) throw new Error("MATLAB plugin requires the downstream registry.");
    const skillCatalog = new MatlabSkillCatalog(discoverMatlabAgenticToolkit().root);
    const skillDescriptorSchema = z.object({
      id: z.string(),
      source: z.enum(["matlab", "simulink"]),
      group: z.string(),
      description: z.string(),
      version: z.string().optional()
    });

    exposer.expose("matlab.skill_list", {
      description: "List or search installed MathWorks MATLAB/Simulink Agentic Toolkit skills.",
      inputSchema: z.object({
        source: z.enum(["matlab", "simulink"]).optional(),
        group: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      outputSchema: z.object({
        total: z.number().int().nonnegative(),
        count: z.number().int().nonnegative(),
        skills: z.array(skillDescriptorSchema)
      })
    }, async ({ source, group, query, limit }) => {
      const skills = skillCatalog.list({ source, group, query, limit });
      const result = { total: skillCatalog.count(), count: skills.length, skills };
      return structuredResult(result, JSON.stringify(result, null, 2));
    });

    exposer.expose("matlab.skill_read", {
      description: "Read one installed MathWorks MATLAB/Simulink Agentic Toolkit skill by stable skill id.",
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: skillDescriptorSchema.extend({ content: z.string() })
    }, async ({ id }) => {
      const skill = skillCatalog.read(id);
      return structuredResult(skill, skill.content);
    });

    exposer.expose("matlab.call_tool", {
      description: "Call one tool on the MathWorks MATLAB MCP Server using the active Workspace binding.",
      inputSchema: z.object({
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional()
      }),
      outputSchema: z.object({ result: z.unknown() })
    }, async ({ tool, arguments: args }) => {
      const workspaceRoot = context.workspaceManager.currentRoot();
      const guardedArgs = guardMatlabWorkspaceArguments(args ?? {}, workspaceRoot);

      if (tool === "evaluate_matlab_code") {
        if (guardedArgs.project_path === undefined) {
          guardedArgs.project_path = workspaceRoot;
        }
      } else {
        await downstream.callTool("matlab", "evaluate_matlab_code", {
          project_path: workspaceRoot,
          code: "1;"
        });
      }

      const result = await downstream.callTool("matlab", tool, guardedArgs);
      return structuredResult({ result }, JSON.stringify(result, null, 2));
    });
  }
};
