import type { CapabilityCatalog } from "../capability/registry.js";
import { summarizeToolInput } from "../monitor/live-activity.js";
import { classifyShellCommand } from "../shell/policy.js";

export type PermissionMode = "allow" | "confirm" | "deny";

export type PermissionDecision = {
  mode: PermissionMode;
  capability: string;
  operation: string;
  reason: string;
  purpose: string;
  inputSummary?: string;
};

const MATLAB_READ_TOOLS = new Set([
  "check_matlab_code",
  "detect_matlab_toolboxes",
  "model_check",
  "model_overview",
  "model_query_params",
  "model_read",
  "model_read_diagnostics",
  "model_resolve_params"
]);

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function common(
  capability: string,
  mode: PermissionMode,
  operation: string,
  reason: string,
  purpose: string,
  args: unknown
): PermissionDecision {
  const inputSummary = summarizeToolInput(capability, args);
  return {
    mode,
    capability,
    operation,
    reason,
    purpose,
    ...(inputSummary ? { inputSummary } : {})
  };
}

export async function permissionDecision(
  capability: string,
  args: unknown,
  catalog: CapabilityCatalog,
  workspaceRoot: string
): Promise<PermissionDecision> {
  const input = record(args);

  if (capability === "shell_run") {
    const command = stringField(input, "command") ?? "";
    const cwd = stringField(input, "cwd") ?? workspaceRoot;
    const shell = await classifyShellCommand(command, workspaceRoot, cwd);
    return common(
      capability,
      shell.mode,
      capability,
      shell.reason,
      shell.purpose,
      args
    );
  }

  if (capability === "matlab.call_tool") {
    const tool = stringField(input, "tool") ?? "unknown";
    const readOnly = MATLAB_READ_TOOLS.has(tool);
    return common(
      capability,
      readOnly ? "allow" : "confirm",
      `matlab:${tool}`,
      readOnly
        ? "recognized read-only MATLAB/Simulink downstream tool"
        : "MATLAB/Simulink execution or mutation requires confirmation",
      readOnly
        ? `调用 MATLAB/Simulink 只读工具“${tool}”读取或检查当前 Workspace。`
        : `调用 MATLAB/Simulink 工具“${tool}”；该工具可能执行代码、运行测试或修改模型。`,
      args
    );
  }

  if (capability === "mcp_call_tool") {
    const server = stringField(input, "server") ?? "unknown";
    const tool = stringField(input, "tool") ?? "unknown";
    return common(
      capability,
      "confirm",
      `mcp:${server}:${tool}`,
      "generic downstream MCP execution requires confirmation",
      `调用下游 MCP “${server} / ${tool}”；P05 无法从 Core 保证该下游工具没有写入或外部副作用。`,
      args
    );
  }

  if (capability === "git_push") {
    const remote = stringField(input, "remote") ?? "origin";
    return common(
      capability,
      "confirm",
      `git_push:${remote}`,
      "Git push changes an external remote repository",
      `把当前 Git 分支推送到远程仓库“${remote}”，会产生外部持久化修改。`,
      args
    );
  }

  if (capability === "runtime_restart") {
    return common(
      capability,
      "confirm",
      capability,
      "Runtime lifecycle change requires confirmation in V2",
      "重启当前 P05 Runtime；会中断并重新启动当前 Runtime 进程。",
      args
    );
  }

  if (capability === "command_run") {
    const action = stringField(input, "action") ?? "unknown";
    return common(
      capability,
      "confirm",
      `command_run:${action}`,
      "repository validation executes mutable repository code",
      `运行 P05 平台验证动作“${action}”；该动作会执行当前仓库中的构建或测试代码。`,
      args
    );
  }

  const descriptor = catalog.descriptor(capability);

  if (descriptor.risk === "read") {
    return common(
      capability,
      "allow",
      capability,
      "read-only capability",
      descriptor.summary,
      args
    );
  }

  if (descriptor.risk === "write" && descriptor.scope === "workspace") {
    return common(
      capability,
      "allow",
      capability,
      "structured Workspace mutation remains inside its existing guard",
      descriptor.summary,
      args
    );
  }

  if (
    descriptor.scope === "external" ||
    descriptor.scope === "host" ||
    descriptor.scope === "downstream" ||
    descriptor.risk === "execute"
  ) {
    return common(
      capability,
      "confirm",
      capability,
      "host, external, downstream or arbitrary execution requires confirmation",
      descriptor.summary,
      args
    );
  }

  return common(
    capability,
    "confirm",
    capability,
    "non-read capability requires confirmation by default",
    descriptor.summary,
    args
  );
}
