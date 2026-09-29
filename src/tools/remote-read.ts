import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readOwnEnv } from "../env.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;

export const REMOTE_READ_TARGETS = ["h1", "j1"] as const;
export type RemoteReadTarget = (typeof REMOTE_READ_TARGETS)[number];

export const REMOTE_READ_OPERATIONS = [
  "host.identity",
  "network.status",
  "service.ssh.status",
  "storage.status",
  "gpu.status",
  "container.status",
  "k3s.status"
] as const;
export type RemoteReadOperation = (typeof REMOTE_READ_OPERATIONS)[number];

const COMMANDS: Record<
  RemoteReadTarget,
  Partial<Record<RemoteReadOperation, string>>
> = {
  h1: {
    "host.identity": "hostname; whoami; uname -a",
    "network.status": "ip -br addr; printf '\\nROUTES\\n'; ip route",
    "service.ssh.status": "systemctl is-active ssh; systemctl is-enabled ssh",
    "storage.status":
      "lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL; printf '\\nFILESYSTEMS\\n'; df -hT",
    "gpu.status": "nvidia-smi",
    "container.status":
      "systemctl is-active containerd || true; systemctl is-active k3s || true; systemctl is-active docker || true",
    "k3s.status":
      "sudo -n k3s kubectl get nodes -o wide; sudo -n k3s kubectl get pods -A"
  },
  j1: {
    "host.identity": "hostname; whoami; uname -a",
    "network.status": "ip -br addr; printf '\\nROUTES\\n'; ip route",
    "service.ssh.status": "systemctl is-active ssh; systemctl is-enabled ssh",
    "storage.status":
      "lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL; printf '\\nFILESYSTEMS\\n'; df -hT",
    "gpu.status": "timeout 3 tegrastats --interval 1000 || true",
    "container.status":
      "systemctl is-active containerd || true; systemctl is-active docker || true"
  }
};

function bounded(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return text;
  return Buffer.from(text, "utf8")
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString("utf8") + "\n[TRUNCATED: remote output exceeded 256 KiB]";
}

function requiredEnv(name: string): string {
  const value = readOwnEnv(name)?.trim();
  if (!value) {
    throw new Error(
      `Remote read target is not configured: ${name} is required.`
    );
  }
  return value;
}

function validateHost(value: string, name: string): string {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) ||
    value.includes("..")
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function validateUser(value: string, name: string): string {
  if (!/^[a-z_][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function validateLocalIdentity(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("P05_REMOTE_READ_H1_IDENTITY must be an absolute path.");
  }
  return path.resolve(value);
}

function validateRemoteIdentity(value: string): string {
  if (
    !value.startsWith("/") ||
    /[\r\n"'\x00]/.test(value)
  ) {
    throw new Error(
      "P05_REMOTE_READ_J1_IDENTITY_ON_H1 must be an absolute POSIX path."
    );
  }
  return value;
}

function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function sshBase(identityFile: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes",
    "-i", identityFile
  ];
}

export type RemoteReadInvocation = {
  executable: string;
  args: string[];
};

export function remoteReadCommand(
  target: RemoteReadTarget,
  operation: RemoteReadOperation
): string {
  const command = COMMANDS[target][operation];
  if (!command) {
    throw new Error(
      `Remote read operation "${operation}" is not supported for target "${target}".`
    );
  }
  return command;
}

export function buildRemoteReadInvocation(
  target: RemoteReadTarget,
  operation: RemoteReadOperation
): RemoteReadInvocation {
  const command = remoteReadCommand(target, operation);
  const executable =
    readOwnEnv("P05_REMOTE_READ_SSH_PATH")?.trim() ||
    (process.platform === "win32" ? "ssh.exe" : "ssh");

  const h1Host = validateHost(
    requiredEnv("P05_REMOTE_READ_H1_HOST"),
    "P05_REMOTE_READ_H1_HOST"
  );
  const h1User = validateUser(
    requiredEnv("P05_REMOTE_READ_H1_USER"),
    "P05_REMOTE_READ_H1_USER"
  );
  const h1Identity = validateLocalIdentity(
    requiredEnv("P05_REMOTE_READ_H1_IDENTITY")
  );
  const h1Destination = `${h1User}@${h1Host}`;

  if (target === "h1") {
    return {
      executable,
      args: [...sshBase(h1Identity), h1Destination, command]
    };
  }

  const j1Host = validateHost(
    requiredEnv("P05_REMOTE_READ_J1_HOST"),
    "P05_REMOTE_READ_J1_HOST"
  );
  const j1User = validateUser(
    requiredEnv("P05_REMOTE_READ_J1_USER"),
    "P05_REMOTE_READ_J1_USER"
  );
  const j1Identity = validateRemoteIdentity(
    requiredEnv("P05_REMOTE_READ_J1_IDENTITY_ON_H1")
  );

  const nested = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes",
    "-i", posixQuote(j1Identity),
    `${j1User}@${j1Host}`,
    posixQuote(command)
  ].join(" ");

  return {
    executable,
    args: [...sshBase(h1Identity), h1Destination, nested]
  };
}

function sanitizedFailure(
  error: unknown,
  target: RemoteReadTarget,
  operation: RemoteReadOperation
): Error {
  const value = error as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stdout = typeof value.stdout === "string" ? bounded(value.stdout) : "";
  const stderr = typeof value.stderr === "string" && value.stderr.trim()
    ? bounded(value.stderr)
    : "remote SSH execution failed";
  return new Error(
    [
      `Remote read failed for ${target} / ${operation}.`,
      stdout ? `STDOUT:\n${stdout}` : "",
      stderr ? `STDERR:\n${stderr}` : ""
    ].filter(Boolean).join("\n")
  );
}

export async function runRemoteRead(
  target: RemoteReadTarget,
  operation: RemoteReadOperation
): Promise<{ stdout: string; stderr: string }> {
  const invocation = buildRemoteReadInvocation(target, operation);
  try {
    const { stdout, stderr } = await execFileAsync(
      invocation.executable,
      invocation.args,
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES
      }
    );
    return {
      stdout: bounded(stdout),
      stderr: bounded(stderr)
    };
  } catch (error) {
    throw sanitizedFailure(error, target, operation);
  }
}
