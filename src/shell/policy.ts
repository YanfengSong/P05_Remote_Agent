import fs from "node:fs/promises";
import { assertAccessiblePath } from "../security.js";

export type ShellPolicyDecision = {
  mode: "allow" | "confirm" | "deny";
  reason: string;
  purpose: string;
};

const SAFE_NO_PATH = new Set([
  "write-output",
  "write-host",
  "get-location",
  "pwd",
  "get-process",
  "get-ciminstance",
  "get-service",
  "get-command",
  "get-date",
  "where.exe"
]);

const SAFE_PATH_READ = new Set([
  "get-content",
  "get-childitem",
  "dir",
  "ls",
  "test-path",
  "resolve-path",
  "get-item",
  "get-filehash"
]);

const SAFE_GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files"
]);

const SAFE_PATH_WRITE = new Set([
  "set-content",
  "add-content",
  "clear-content",
  "remove-item"
]);

const PATH_FLAGS = new Set(["-path", "-literalpath"]);

function hasDynamicOrCompoundSyntax(command: string): boolean {
  return /[\r\n;|&><`$(){}\[\],]/.test(command);
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

function flagValues(tokens: string[], flags: Set<string>): string[] {
  const values: string[] = [];
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (flags.has(tokens[i]!.toLowerCase())) values.push(tokens[i + 1]!);
  }
  return values;
}

function positionalPaths(tokens: string[]): string[] {
  const values: string[] = [];
  const flagsWithValues = new Set([
    "-path",
    "-literalpath",
    "-filter",
    "-include",
    "-exclude",
    "-encoding",
    "-erroraction",
    "-algorithm"
  ]);

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (flagsWithValues.has(token.toLowerCase())) i += 1;
      continue;
    }
    values.push(token);
  }
  return values;
}

function displayTargets(values: string[]): string {
  return values.length
    ? values.map((value) => `“${value}”`).join("、")
    : "未明确指定目标";
}

function describe(tokens: string[] | undefined): string {
  if (!tokens?.length) {
    return "执行一条无法可靠解析的 PowerShell 命令；系统无法确认其完整行为。";
  }

  const executable = tokens[0]!.toLowerCase();
  const explicit = flagValues(tokens, PATH_FLAGS);
  const paths = explicit.length ? explicit : positionalPaths(tokens);

  switch (executable) {
    case "write-output":
    case "write-host":
      return "显示文本输出；不会直接修改文件。";
    case "get-location":
    case "pwd":
      return "读取当前工作目录；不会修改文件。";
    case "get-date":
      return "读取当前系统日期和时间；不会修改文件。";
    case "get-process":
      return "读取当前进程信息；不会修改文件。";
    case "get-service":
      return "读取系统服务状态；不会修改文件。";
    case "get-ciminstance":
      return "读取系统管理信息；不会修改文件。";
    case "get-command":
    case "where.exe":
      return "查询命令或可执行程序位置；不会直接修改文件。";
    case "get-content":
      return `读取文件内容：${displayTargets(paths)}。`;
    case "get-childitem":
    case "dir":
    case "ls":
      return `列出目录内容：${displayTargets(paths)}。`;
    case "test-path":
      return `检查路径是否存在：${displayTargets(paths)}。`;
    case "resolve-path":
      return `解析路径实际位置：${displayTargets(paths)}。`;
    case "get-item":
      return `读取文件或目录属性：${displayTargets(paths)}。`;
    case "get-filehash":
      return `读取文件并计算哈希：${displayTargets(paths)}；不会修改文件。`;
    case "set-content":
      return `写入并覆盖文件内容：${displayTargets(paths)}。`;
    case "add-content":
      return `向文件追加内容：${displayTargets(paths)}。`;
    case "clear-content":
      return `清空文件内容：${displayTargets(paths)}。`;
    case "remove-item":
      return `删除文件或目录：${displayTargets(paths)}。`;
    case "git":
    case "git.exe": {
      const sub = tokens.slice(1).find((token) => !token.startsWith("-"));
      if (sub === "status") return "查看 Git 工作区状态；不会修改仓库。";
      if (sub === "diff") return "查看 Git 差异；不会修改仓库。";
      if (sub === "log" || sub === "show") return "查看 Git 历史或对象；不会修改仓库。";
      return `执行 Git ${sub ?? "命令"}；该操作可能修改仓库或访问外部资源。`;
    }
    default:
      return `执行 PowerShell 命令“${tokens[0]}”；该命令不在自动允许的安全集合中。`;
  }
}

function isDriveRoot(value: string): boolean {
  return /^[a-zA-Z]:[\\/]?(?:\*)?$/.test(value.trim());
}

function catastrophic(tokens: string[]): string | undefined {
  const executable = tokens[0]!.toLowerCase();

  if (
    executable === "format" ||
    executable === "format.com" ||
    executable === "diskpart" ||
    executable === "clear-disk" ||
    executable === "initialize-disk" ||
    executable === "remove-partition"
  ) {
    return "disk-wide destructive operations are denied";
  }

  if (executable === "remove-item") {
    const targets = [
      ...flagValues(tokens, PATH_FLAGS),
      ...positionalPaths(tokens)
    ];
    const recursive = tokens.some((token) =>
      token.toLowerCase() === "-recurse" ||
      token.toLowerCase() === "-r"
    );
    if (recursive && targets.some(isDriveRoot)) {
      return "recursive deletion of a drive root is denied";
    }
  }

  return undefined;
}

async function allPathsInside(
  values: string[],
  access: "read" | "write",
  cwd: string,
  workspaceRoot: string
): Promise<boolean> {
  if (!values.length) return false;

  for (const value of values) {
    if (!value || /[*?~]/.test(value)) return false;
    try {
      const safe = await assertAccessiblePath(
        value,
        access,
        cwd,
        workspaceRoot
      );
      if (access === "write") {
        try {
          const stat = await fs.lstat(safe);
          if (stat.isFile() && stat.nlink > 1) return false;
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function explainShellCommand(command: string): string {
  return describe(tokenize(command.trim()));
}

export async function classifyShellCommand(
  command: string,
  workspaceRoot: string,
  cwd: string
): Promise<ShellPolicyDecision> {
  const tokens = tokenize(command.trim());
  const purpose = describe(tokens);

  if (!tokens?.length) {
    return {
      mode: "confirm",
      reason: "command could not be parsed conservatively",
      purpose
    };
  }

  const destructive = catastrophic(tokens);
  if (destructive) {
    return { mode: "deny", reason: destructive, purpose };
  }

  if (hasDynamicOrCompoundSyntax(command)) {
    return {
      mode: "confirm",
      reason: "dynamic, compound or nested shell syntax requires confirmation",
      purpose
    };
  }

  const executable = tokens[0]!.toLowerCase();
  if (/[\\/]/.test(tokens[0]!) || /^[a-zA-Z]:/.test(tokens[0]!)) {
    return {
      mode: "confirm",
      reason: "explicit executable paths require confirmation",
      purpose
    };
  }

  if (SAFE_NO_PATH.has(executable)) {
    return {
      mode: "allow",
      reason: "recognized read-only diagnostic command",
      purpose
    };
  }

  if (SAFE_PATH_READ.has(executable)) {
    if (
      (executable === "get-childitem" || executable === "dir" || executable === "ls") &&
      tokens.some((token) => "-followsymlink".startsWith(token.toLowerCase()))
    ) {
      return {
        mode: "confirm",
        reason: "following symbolic links is not auto-approved",
        purpose
      };
    }

    const explicit = flagValues(tokens, PATH_FLAGS);
    const paths = explicit.length ? explicit : positionalPaths(tokens);
    return (await allPathsInside(paths, "read", cwd, workspaceRoot))
      ? {
          mode: "allow",
          reason: "recognized read-only command with Workspace-local paths",
          purpose
        }
      : {
          mode: "confirm",
          reason: "read path is outside, dynamic or ambiguous",
          purpose
        };
  }

  if (SAFE_PATH_WRITE.has(executable)) {
    const paths = flagValues(tokens, PATH_FLAGS);
    if (!paths.length) {
      return {
        mode: "confirm",
        reason: "automatic shell writes require explicit -Path or -LiteralPath",
        purpose
      };
    }
    return (await allPathsInside(paths, "write", cwd, workspaceRoot))
      ? {
          mode: "allow",
          reason: "recognized static Workspace-local file operation",
          purpose
        }
      : {
          mode: "confirm",
          reason: "write path is outside, protected, linked or ambiguous",
          purpose
        };
  }

  if (executable === "git" || executable === "git.exe") {
    const blockedOption = tokens.find((token) => {
      const lower = token.toLowerCase();
      return (
        token === "-C" ||
        /^-C.+/.test(token) ||
        lower.startsWith("--git-dir") ||
        lower.startsWith("--work-tree") ||
        lower.startsWith("--exec-path") ||
        token === "-c" ||
        /^-c.+/.test(token) ||
        lower.startsWith("--config-env") ||
        lower === "--no-index" ||
        lower === "--ext-diff" ||
        lower === "--textconv" ||
        lower === "--output" ||
        lower.startsWith("--output=")
      );
    });
    if (blockedOption) {
      return {
        mode: "confirm",
        reason: "Git path/config/helper/output overrides require confirmation",
        purpose
      };
    }

    const sub = tokens.slice(1).find((token) => !token.startsWith("-"))?.toLowerCase();
    if (sub && SAFE_GIT_READ.has(sub)) {
      return {
        mode: "allow",
        reason: `recognized Git read command: ${sub}`,
        purpose
      };
    }
  }

  return {
    mode: "confirm",
    reason: "shell command is not in the small automatic allowlist",
    purpose
  };
}
