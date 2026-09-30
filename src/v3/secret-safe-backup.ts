import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class SecretSafeBackupError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "SecretSafeBackupError"; }
}

export type BackupSource = { name: string; file: string };

export function createSecretSafeBackup(input: {
  destination: string;
  sources: BackupSource[];
  containsSecret: (bytes: Buffer) => boolean;
  maxSourceBytes?: number;
}): { files: string[] } {
  if (!path.isAbsolute(input.destination) || path.parse(input.destination).root === input.destination) throw new SecretSafeBackupError("INVALID_BACKUP_DESTINATION");
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 128) throw new SecretSafeBackupError("INVALID_BACKUP_SOURCES");
  const maxSourceBytes = input.maxSourceBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 512 * 1024 * 1024) throw new SecretSafeBackupError("INVALID_BACKUP_LIMIT");
  const prepared: { name: string; bytes: Buffer }[] = [];
  const names = new Set<string>();
  for (const source of input.sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.name) || names.has(source.name) || !path.isAbsolute(source.file)) throw new SecretSafeBackupError("INVALID_BACKUP_SOURCE");
    names.add(source.name);
    const stat = fs.lstatSync(source.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSourceBytes) throw new SecretSafeBackupError("INVALID_BACKUP_SOURCE");
    const bytes = fs.readFileSync(source.file);
    if (input.containsSecret(bytes)) throw new SecretSafeBackupError("BACKUP_SECRET_DETECTED");
    prepared.push({ name: source.name, bytes });
  }
  const target = path.resolve(input.destination);
  if (fs.existsSync(target)) throw new SecretSafeBackupError("BACKUP_DESTINATION_EXISTS");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = target + ".staging-" + process.pid + "-" + randomUUID();
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const item of prepared) fs.writeFileSync(path.join(staging, item.name), item.bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(staging, target);
    return { files: prepared.map(item => path.join(target, item.name)) };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}