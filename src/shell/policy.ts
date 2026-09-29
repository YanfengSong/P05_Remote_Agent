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

const SAFE_IMPLICIT_CWD_READ = new Set([
  "get-childitem",
  "dir",
  "ls"
]);

const SAFE_PIPE_FILTER = new Set([
  "select-object",
  "sort-object",
  "group-object",
  "measure-object",
  "format-table",
  "format-list",
  "out-string",
  "convertto-json"
]);

const PATH_FLAGS = new Set(["-path", "-literalpath"]);

const SAFE_SSH_FLAG_OPTIONS = new Set(["-4", "-6", "-q", "-T"]);
const SAFE_REMOTE_SIMPLE = new Set([
  "df",
  "findmnt",
  "free",
  "id",
  "ls",
  "lsblk",
  "ps",
  "pwd",
  "ss",
  "stat",
  "uname"
]);
const SAFE_SYSTEMCTL_READ = new Set([
  "cat",
  "is-active",
  "is-enabled",
  "is-failed",
  "is-system-running",
  "list-dependencies",
  "list-jobs",
  "list-unit-files",
  "list-units",
  "show",
  "show-environment",
  "status"
]);
const SAFE_KUBECTL_READ = new Set([
  "api-resources",
  "api-versions",
  "auth",
  "cluster-info",
  "describe",
  "get",
  "logs",
  "version"
]);
const KUBECTL_SENSITIVE_RESOURCES = new Set(["secret", "secrets"]);

function safeSshOption(value: string): boolean {
  const equals = value.indexOf("=");
  if (equals <= 0) return false;
  const key = value.slice(0, equals).toLowerCase();
  const optionValue = value.slice(equals + 1).toLowerCase();

  if (key === "batchmode" || key === "identitiesonly") {
    return optionValue === "yes";
  }
  if (key === "stricthostkeychecking") {
    return optionValue === "yes";
  }
  if (key === "connecttimeout" || key === "serveraliveinterval" || key === "serveralivecountmax") {
    return /^\d{1,4}$/.test(optionValue);
  }
  if (key === "loglevel") {
    return ["quiet", "fatal", "error", "info"].includes(optionValue);
  }
  return false;
}

function sshRemoteCommand(tokens: string[]): string | undefined {
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;

    if (SAFE_SSH_FLAG_OPTIONS.has(token)) {
      i += 1;
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === "-i") {
      const identity = tokens[i + 1];
      if (!identity || identity.startsWith("-")) return undefined;
      i += 2;
      continue;
    }
    if (lower === "-p") {
      const port = tokens[i + 1];
      if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        return undefined;
      }
      i += 2;
      continue;
    }
    if (lower === "-l") {
      const user = tokens[i + 1];
      if (!user || !/^[A-Za-z0-9._-]+$/.test(user)) return undefined;
      i += 2;
      continue;
    }
    if (lower === "-o") {
      const option = tokens[i + 1];
      if (!option || !safeSshOption(option)) return undefined;
      i += 2;
      continue;
    }
    if (lower.startsWith("-o") && token.length > 2) {
      if (!safeSshOption(token.slice(2))) return undefined;
      i += 1;
      continue;
    }

    return undefined;
  }

  const destination = tokens[i];
  if (
    !destination ||
    !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(destination)
  ) {
    return undefined;
  }

  const remote = tokens.slice(i + 1).join(" ").trim();
  return remote || undefined;
}

function hostnameReadOnly(tokens: string[]): boolean {
  if (tokens.length === 1) return true;
  const flags = new Set([
    "-a", "--alias",
    "-d", "--domain",
    "-f", "--fqdn", "--long",
    "-i", "--ip-address",
    "-I", "--all-ip-addresses",
    "-s", "--short",
    "-y", "--yp", "--nis"
  ]);
  return tokens.slice(1).every((token) => flags.has(token));
}

function uptimeReadOnly(tokens: string[]): boolean {
  const flags = new Set(["-p", "--pretty", "-s", "--since", "-V", "--version"]);
  return tokens.slice(1).every((token) => flags.has(token));
}

function ipReadOnly(tokens: string[]): boolean {
  const mutations = new Set([
    "add", "append", "change", "del", "delete", "flush",
    "replace", "set"
  ]);
  if (tokens.slice(1).some((token) => mutations.has(token.toLowerCase()))) return false;

  const object = tokens
    .slice(1)
    .find((token) => !token.startsWith("-"))
    ?.toLowerCase();
  return Boolean(object && [
    "addr", "address", "link", "neigh", "neighbor", "route", "rule"
  ].includes(object));
}

function systemctlReadOnly(tokens: string[]): boolean {
  const sub = tokens.slice(1).find((token) => !token.startsWith("-"))?.toLowerCase();
  return Boolean(sub && SAFE_SYSTEMCTL_READ.has(sub));
}

function passwdReadOnly(tokens: string[]): boolean {
  return (
    tokens.length === 3 &&
    ["-s", "--status"].includes(tokens[1]!.toLowerCase()) &&
    /^[A-Za-z0-9._-]+$/.test(tokens[2]!)
  );
}

function grepAptConfigReadOnly(tokens: string[]): boolean {
  if (tokens.length < 3) return false;

  const allowedFlags = new Set([
    "-r", "-R",
    "-n", "--line-number",
    "-H", "--with-filename",
    "-h", "--no-filename",
    "-i", "--ignore-case",
    "-F", "--fixed-strings",
    "-E", "--extended-regexp"
  ]);

  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    if (!allowedFlags.has(tokens[i]!)) return false;
    i += 1;
  }

  if (i >= tokens.length - 1) return false;
  i += 1; // skip the literal search pattern

  const paths = tokens.slice(i);
  return paths.length > 0 && paths.every((value) => {
    if (value === "/etc/apt") return true;
    if (!value.startsWith("/etc/apt/")) return false;
    const segments = value.slice("/etc/apt/".length).split("/");
    return segments.length > 0 && segments.every((segment) =>
      Boolean(segment) &&
      segment !== "." &&
      segment !== ".." &&
      !/[*?~]/.test(segment)
    );
  });
}

function dpkgReadOnly(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  const action = tokens[1]!.toLowerCase();
  return [
    "-s", "--status",
    "-l", "--list",
    "-s", "--search"
  ].includes(action);
}

function dpkgQueryReadOnly(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  const action = tokens[1]!.toLowerCase();
  return [
    "-s", "--status",
    "-l", "--list",
    "-w", "--show",
    "-s", "--search"
  ].includes(action);
}

function nvidiaSmiReadOnly(tokens: string[]): boolean {
  if (tokens.length === 1) return true;
  if (tokens.length === 2 && ["-l", "--list-gpus"].includes(tokens[1]!.toLowerCase())) {
    return true;
  }
  return tokens.slice(1).every((token) => {
    const lower = token.toLowerCase();
    return lower.startsWith("--query-gpu=") ||
      lower.startsWith("--query-compute-apps=") ||
      lower.startsWith("--format=");
  });
}

function kubectlReadOnly(tokens: string[]): boolean {
  if (!tokens.length) return false;
  const sub = tokens.find((token) => !token.startsWith("-"))?.toLowerCase();
  if (!sub || !SAFE_KUBECTL_READ.has(sub)) return false;

  if (sub === "auth") {
    return tokens.some((token) => token.toLowerCase() === "can-i");
  }

  if (sub === "get" || sub === "describe") {
    const subIndex = tokens.findIndex((token) => token.toLowerCase() === sub);
    const resource = tokens
      .slice(subIndex + 1)
      .find((token) => !token.startsWith("-"))
      ?.split(/[\/,]/)[0]
      ?.toLowerCase();
    if (resource && KUBECTL_SENSITIVE_RESOURCES.has(resource)) return false;
  }

  return true;
}

function remoteCommandReadOnly(command: string, depth = 0): boolean {
  if (depth > 2 || hasDynamicOrCompoundSyntax(command)) return false;

  const tokens = tokenize(command.trim());
  if (!tokens?.length) return false;

  const executable = tokens[0]!.toLowerCase();
  if (/[\\/]/.test(tokens[0]!) || /^[a-zA-Z]:/.test(tokens[0]!)) return false;

  if (executable === "ssh" || executable === "ssh.exe") {
    const nested = sshRemoteCommand(tokens);
    return Boolean(nested && remoteCommandReadOnly(nested, depth + 1));
  }

  if (executable === "sudo") {
    if (tokens[1]?.toLowerCase() !== "-n" || tokens.length < 3) return false;
    return remoteCommandReadOnly(tokens.slice(2).join(" "), depth + 1);
  }

  if (executable === "k3s") {
    if (tokens[1]?.toLowerCase() !== "kubectl") return false;
    return kubectlReadOnly(tokens.slice(2));
  }

  if (executable === "kubectl") return kubectlReadOnly(tokens.slice(1));
  if (executable === "hostname") return hostnameReadOnly(tokens);
  if (executable === "uptime") return uptimeReadOnly(tokens);
  if (executable === "whoami" || executable === "date") return tokens.length === 1;
  if (executable === "ip") return ipReadOnly(tokens);
  if (executable === "systemctl") return systemctlReadOnly(tokens);
  if (executable === "passwd") return passwdReadOnly(tokens);
  if (executable === "nvidia-smi") return nvidiaSmiReadOnly(tokens);
  if (executable === "dpkg") return dpkgReadOnly(tokens);
  if (executable === "dpkg-query") return dpkgQueryReadOnly(tokens);
  if (executable === "grep") return grepAptConfigReadOnly(tokens);
  return SAFE_REMOTE_SIMPLE.has(executable);
}


function hasDynamicOrCompoundSyntax(command: string): boolean {
  return /[\r\n;&><`$(){}\[\]]/.test(command);
}

function splitSimplePipeline(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "|") {
      if (command[i + 1] === "|") return undefined;
      const segment = current.trim();
      if (!segment) return undefined;
      segments.push(segment);
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) return undefined;
  const tail = current.trim();
  if (!tail) return undefined;
  segments.push(tail);
  return segments;
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
  const trimmed = command.trim();
  const pipeline = splitSimplePipeline(trimmed);

  if (!pipeline) {
    return {
      mode: "confirm",
      reason: "command could not be parsed conservatively",
      purpose: "执行一条无法可靠解析的 PowerShell 命令；系统无法确认其完整行为。"
    };
  }

  if (pipeline.length > 1) {
    if (hasDynamicOrCompoundSyntax(trimmed)) {
      return {
        mode: "confirm",
        reason: "dynamic, compound or nested shell syntax requires confirmation",
        purpose: "执行包含动态表达式的 PowerShell 流水线；系统无法证明其只读。"
      };
    }

    const segmentTokens = pipeline.map((segment) => tokenize(segment));
    if (segmentTokens.some((tokens) => !tokens?.length)) {
      return {
        mode: "confirm",
        reason: "pipeline segment could not be parsed conservatively",
        purpose: "执行一条无法可靠解析的 PowerShell 流水线。"
      };
    }

    for (const tokens of segmentTokens as string[][]) {
      const destructive = catastrophic(tokens);
      if (destructive) {
        return { mode: "deny", reason: destructive, purpose: describe(tokens) };
      }
    }

    const source = await classifyShellCommand(pipeline[0]!, workspaceRoot, cwd);
    if (source.mode !== "allow") return source;

    for (let i = 1; i < segmentTokens.length; i += 1) {
      const tokens = segmentTokens[i] as string[];
      const executable = tokens[0]!.toLowerCase();
      if (
        /[\\/]/.test(tokens[0]!) ||
        /^[a-zA-Z]:/.test(tokens[0]!) ||
        !SAFE_PIPE_FILTER.has(executable)
      ) {
        return {
          mode: "confirm",
          reason: "pipeline contains a command that is not a recognized read-only filter",
          purpose: "读取数据后执行未被证明为只读的流水线处理。"
        };
      }
    }

    return {
      mode: "allow",
      reason: "recognized read-only command pipeline",
      purpose: source.purpose + " 结果仅经过只读筛选或格式化。"
    };
  }

  const tokens = tokenize(trimmed);
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

  if (hasDynamicOrCompoundSyntax(trimmed)) {
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

  if (executable === "ssh" || executable === "ssh.exe") {
    const remote = sshRemoteCommand(tokens);
    if (remote && remoteCommandReadOnly(remote)) {
      return {
        mode: "allow",
        reason: "static SSH invocation contains only recognized read-only remote behavior",
        purpose: "通过 SSH 执行静态、可证明只读的远端查询命令。"
      };
    }
    return {
      mode: "confirm",
      reason: "SSH invocation is interactive, mutating, transport-mutating or not provably read-only",
      purpose: "通过 SSH 执行无法证明为纯只读的远端行为；需要人工确认。"
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
    if (paths.length === 0 && SAFE_IMPLICIT_CWD_READ.has(executable)) {
      return {
        mode: "allow",
        reason: "recognized read-only command using the current Workspace directory",
        purpose
      };
    }
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
