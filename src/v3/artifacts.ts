import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ArtifactProtection = "active-run" | "pending-review" | "rollback" | "pin";
export type ArtifactRecord = {
  artifactId: string;
  producerRun: string;
  digest: string;
  mediaType: string;
  size: number;
  createdAt: number;
  completedAt: number | null;
  retentionUntil: number;
  protections: ArtifactProtection[];
};

export class ArtifactStoreError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "ArtifactStoreError"; }
}

export type ArtifactStoreOptions = {
  root: string;
  now?: () => number;
  defaultRetentionMs?: number;
};

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function uniqueProtections(values: ArtifactProtection[]): ArtifactProtection[] {
  const valid = new Set<ArtifactProtection>(["active-run", "pending-review", "rollback", "pin"]);
  if (!Array.isArray(values) || values.some(value => !valid.has(value))) throw new ArtifactStoreError("INVALID_ARTIFACT_PROTECTION");
  return [...new Set(values)].sort() as ArtifactProtection[];
}

export class ArtifactStore {
  private readonly db: DatabaseSync;
  private readonly blobs: string;
  private readonly now: () => number;
  private readonly defaultRetentionMs: number;

  constructor(options: ArtifactStoreOptions) {
    if (!path.isAbsolute(options.root)) throw new ArtifactStoreError("ARTIFACT_ROOT_MUST_BE_ABSOLUTE");
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const realRoot = fs.realpathSync(options.root);
    const stat = fs.lstatSync(realRoot);
    if (stat.isSymbolicLink()) throw new ArtifactStoreError("UNTRUSTED_ARTIFACT_ROOT");
    this.blobs = path.join(realRoot, "blobs");
    fs.mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.now = options.now ?? Date.now;
    this.defaultRetentionMs = options.defaultRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.defaultRetentionMs) || this.defaultRetentionMs < 0) throw new ArtifactStoreError("INVALID_ARTIFACT_RETENTION");
    this.db = new DatabaseSync(path.join(realRoot, "artifacts.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS artifacts(
        artifact_id TEXT PRIMARY KEY,
        producer_run TEXT NOT NULL,
        digest TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        retention_until INTEGER NOT NULL,
        protections TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_digest ON artifacts(digest);
    `);
  }

  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new ArtifactStoreError("INVALID_ARTIFACT_CLOCK");
    return value;
  }

  private blobPath(digest: string): string { return path.join(this.blobs, digest.slice(0, 2), digest.slice(2)); }

  publish(input: { producerRun: string; mediaType: string; content: Buffer | string; protections?: ArtifactProtection[]; retentionMs?: number }): ArtifactRecord {
    if (!validId(input.producerRun)) throw new ArtifactStoreError("INVALID_PRODUCER_RUN");
    if (typeof input.mediaType !== "string" || !input.mediaType.trim() || input.mediaType.length > 255) throw new ArtifactStoreError("INVALID_MEDIA_TYPE");
    const retentionMs = input.retentionMs ?? this.defaultRetentionMs;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new ArtifactStoreError("INVALID_ARTIFACT_RETENTION");
    const protections = uniqueProtections(input.protections ?? ["active-run"]);
    const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const finalPath = this.blobPath(digest);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(finalPath)) {
      const temp = finalPath + ".tmp-" + process.pid + "-" + randomUUID();
      fs.writeFileSync(temp, bytes, { mode: 0o600 });
      const written = createHash("sha256").update(fs.readFileSync(temp)).digest("hex");
      if (written !== digest) { fs.rmSync(temp, { force: true }); throw new ArtifactStoreError("ARTIFACT_DIGEST_MISMATCH"); }
      try { fs.renameSync(temp, finalPath); } catch (error: any) {
        fs.rmSync(temp, { force: true });
        if (!fs.existsSync(finalPath)) throw error;
      }
    }
    const now = this.time();
    const record: ArtifactRecord = {
      artifactId: "art-" + randomUUID(),
      producerRun: input.producerRun,
      digest,
      mediaType: input.mediaType,
      size: bytes.length,
      createdAt: now,
      completedAt: null,
      retentionUntil: now + retentionMs,
      protections
    };
    this.db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      record.artifactId, record.producerRun, record.digest, record.mediaType, record.size,
      record.createdAt, null, record.retentionUntil, JSON.stringify(record.protections)
    );
    return structuredClone(record);
  }

  get(artifactId: string): ArtifactRecord {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(artifactId) as any;
    if (!row) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND");
    return {
      artifactId: row.artifact_id,
      producerRun: row.producer_run,
      digest: row.digest,
      mediaType: row.media_type,
      size: Number(row.size),
      createdAt: Number(row.created_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      retentionUntil: Number(row.retention_until),
      protections: JSON.parse(row.protections) as ArtifactProtection[]
    };
  }

  read(artifactId: string): Buffer {
    const record = this.get(artifactId);
    const file = this.blobPath(record.digest);
    if (!fs.existsSync(file)) throw new ArtifactStoreError("ARTIFACT_BLOB_MISSING");
    const bytes = fs.readFileSync(file);
    if (bytes.length !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.digest) throw new ArtifactStoreError("ARTIFACT_BLOB_CORRUPT");
    return bytes;
  }

  updateProtection(artifactId: string, protection: ArtifactProtection, enabled: boolean): ArtifactRecord {
    const record = this.get(artifactId);
    const set = new Set(record.protections);
    if (enabled) set.add(protection); else set.delete(protection);
    record.protections = uniqueProtections([...set]);
    this.db.prepare("UPDATE artifacts SET protections=? WHERE artifact_id=?").run(JSON.stringify(record.protections), artifactId);
    return record;
  }

  completeRun(producerRun: string): number {
    if (!validId(producerRun)) throw new ArtifactStoreError("INVALID_PRODUCER_RUN");
    const now = this.time();
    let changed = 0;
    for (const row of this.db.prepare("SELECT artifact_id FROM artifacts WHERE producer_run=?").all(producerRun) as { artifact_id: string }[]) {
      const record = this.get(row.artifact_id);
      if (!record.protections.includes("active-run")) continue;
      record.protections = record.protections.filter(value => value !== "active-run");
      this.db.prepare("UPDATE artifacts SET completed_at=?, protections=? WHERE artifact_id=?").run(now, JSON.stringify(record.protections), record.artifactId);
      changed++;
    }
    return changed;
  }

  gc(input: { maxScan: number; maxDelete: number }): { scanned: number; deletedArtifacts: number; deletedBlobs: number; protectedArtifacts: number } {
    if (!Number.isSafeInteger(input.maxScan) || input.maxScan < 1 || input.maxScan > 10000 ||
        !Number.isSafeInteger(input.maxDelete) || input.maxDelete < 1 || input.maxDelete > input.maxScan) {
      throw new ArtifactStoreError("INVALID_GC_LIMIT");
    }
    const now = this.time();
    const rows = this.db.prepare("SELECT artifact_id FROM artifacts ORDER BY created_at, artifact_id LIMIT ?").all(input.maxScan) as { artifact_id: string }[];
    let deletedArtifacts = 0, deletedBlobs = 0, protectedArtifacts = 0;
    for (const row of rows) {
      if (deletedArtifacts >= input.maxDelete) break;
      const record = this.get(row.artifact_id);
      if (record.protections.length > 0 || record.completedAt === null || record.retentionUntil > now) { protectedArtifacts++; continue; }
      this.db.prepare("DELETE FROM artifacts WHERE artifact_id=?").run(record.artifactId);
      deletedArtifacts++;
      const remaining = this.db.prepare("SELECT count(*) AS count FROM artifacts WHERE digest=?").get(record.digest) as { count: number };
      if (remaining.count === 0) {
        fs.rmSync(this.blobPath(record.digest), { force: true });
        deletedBlobs++;
      }
    }
    if (deletedArtifacts < input.maxDelete && fs.existsSync(this.blobs)) {
      outer: for (const prefix of fs.readdirSync(this.blobs)) {
        const directory = path.join(this.blobs, prefix);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(directory); } catch { continue; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix)) continue;
        for (const name of fs.readdirSync(directory)) {
          if (deletedArtifacts + deletedBlobs >= input.maxDelete) break outer;
          if (!/^[a-f0-9]{62}$/.test(name)) continue;
          const digest = prefix + name;
          const referenced = this.db.prepare("SELECT count(*) AS count FROM artifacts WHERE digest=?").get(digest) as { count: number };
          if (referenced.count !== 0) continue;
          fs.rmSync(path.join(directory, name), { force: true });
          deletedBlobs++;
        }
      }
    }
    return { scanned: rows.length, deletedArtifacts, deletedBlobs, protectedArtifacts };
  }

  close(): void { this.db.close(); }
}
