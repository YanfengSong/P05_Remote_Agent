import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CompositionError } from "./contracts.js";
import type { ArtifactPromotionSource } from "../artifacts.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const assetInput = z.object({ assetId: id, revision: id, source: z.string().min(1).max(2048), author: id, effects: z.array(z.enum(["E0", "E1", "E2", "E3", "E4"])).max(5) }).strict();
const artifactInput = z.object({ artifactId: id, producerRunId: id, invocationId: id, attemptId: id, inputDigest: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string().min(1).max(128), visibility: id }).strict();
export type AssetDraft = z.infer<typeof assetInput>;
export type ArtifactInput = z.infer<typeof artifactInput>;
export interface AssetRevision extends AssetDraft { contentDigest: string; size: number; state: "DRAFT" | "VERIFIED" | "ACTIVE" | "DEPRECATED" | "REVOKED"; evidenceRef?: string; promotedFromArtifactId?: string; promotedFromRunId?: string; promotedFromArtifactDigest?: string }
export interface ArtifactRecord extends ArtifactInput { contentDigest: string; size: number }

/** Protected local content storage. Methods are trusted administration primitives,
 * not an authorization boundary or a replacement for package signature verification. */
export class AssetStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(private readonly directory: string, private readonly verifyEvidence?: (asset: Readonly<AssetRevision>, evidenceRef: string) => boolean | Promise<boolean>) {
    if (!path.isAbsolute(directory) || /^[/\\]{2}/.test(directory) || path.parse(directory).root === directory || (existsSync(directory) && lstatSync(directory).isSymbolicLink())) throw new CompositionError("INVALID_ASSET_DIRECTORY");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (lstatSync(directory).mode & 0o077) !== 0) throw new CompositionError("UNPROTECTED_ASSET_DIRECTORY");
    const blobs = path.join(directory, "blobs");
    if (existsSync(blobs) && lstatSync(blobs).isSymbolicLink()) throw new CompositionError("INVALID_ASSET_DIRECTORY");
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "assets.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(file + suffix) && lstatSync(file + suffix).isSymbolicLink()) throw new CompositionError("INVALID_ASSET_DIRECTORY");
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS assets (asset_id TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(asset_id,revision)); CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, record TEXT NOT NULL);");
    } catch (error) { this.db.close(); throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new CompositionError("ASSET_STORE_CLOSED"); }
  private hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
  private blob(bytes: Uint8Array): { contentDigest: string; size: number } {
    this.assertOpen();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024) throw new CompositionError("ASSET_BLOB_LIMIT");
    const contentDigest = this.hash(bytes);
    const target = path.join(this.directory, "blobs", contentDigest);
    if (!existsSync(target)) {
      const temporary = path.join(this.directory, "blobs", `.staging-${randomUUID()}`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      try { renameSync(temporary, target); }
      catch (error) { if (!existsSync(target)) throw error; }
      finally { rmSync(temporary, { force: true }); }
    }
    this.readBlob(contentDigest);
    return { contentDigest, size: bytes.byteLength };
  }

  readBlob(contentDigest: string): Buffer {
    this.assertOpen();
    if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new CompositionError("INVALID_CONTENT_DIGEST");
    const target = path.join(this.directory, "blobs", contentDigest);
    if (lstatSync(target).isSymbolicLink()) throw new CompositionError("INVALID_ASSET_BLOB");
    const bytes = readFileSync(target);
    if (this.hash(bytes) !== contentDigest) throw new CompositionError("ASSET_CONTENT_CORRUPTED");
    return bytes;
  }

  createDraft(input: AssetDraft, bytes: Uint8Array): AssetRevision {
    this.assertOpen();
    const validated = assetInput.parse(input);
    if (this.db.prepare("SELECT 1 FROM assets WHERE asset_id=? AND revision=?").get(validated.assetId, validated.revision)) throw new CompositionError("ASSET_REVISION_IMMUTABLE");
    const record: AssetRevision = { ...validated, ...this.blob(bytes), state: "DRAFT" };
    this.db.prepare("INSERT INTO assets VALUES (?, ?, 'DRAFT', ?)").run(record.assetId, record.revision, JSON.stringify(record));
    return record;
  }

  getAsset(assetId: string, revision: string): AssetRevision {
    this.assertOpen();
    const row = this.db.prepare("SELECT record FROM assets WHERE asset_id=? AND revision=?").get(assetId, revision) as { record: string } | undefined;
    if (!row) throw new CompositionError("UNKNOWN_ASSET_REVISION");
    return JSON.parse(row.record) as AssetRevision;
  }

  async verify(assetId: string, revision: string, expectedDigest: string, evidenceRef: string): Promise<AssetRevision> {
    const record = this.getAsset(assetId, revision);
    if (record.state !== "DRAFT" || record.contentDigest !== expectedDigest) throw new CompositionError("STALE_ASSET_VERIFICATION");
    this.readBlob(record.contentDigest);
    if (!this.verifyEvidence || !evidenceRef || evidenceRef.length > 2048 || await this.verifyEvidence(Object.freeze(structuredClone(record)), evidenceRef) !== true) throw new CompositionError("ASSET_VERIFICATION_NOT_PROVEN");
    const verified = { ...record, state: "VERIFIED" as const, evidenceRef };
    const result = this.db.prepare("UPDATE assets SET state='VERIFIED', record=? WHERE asset_id=? AND revision=? AND state='DRAFT'").run(JSON.stringify(verified), assetId, revision);
    if (result.changes !== 1) throw new CompositionError("STALE_ASSET_VERIFICATION");
    return verified;
  }

  activate(assetId: string, revision: string, expectedDigest: string): AssetRevision {
    this.assertOpen(); this.db.exec("BEGIN IMMEDIATE;");
    try {
      const candidate = this.getAsset(assetId, revision);
      if (candidate.state !== "VERIFIED" || candidate.contentDigest !== expectedDigest) throw new CompositionError("ASSET_NOT_VERIFIED");
      this.readBlob(candidate.contentDigest);
      for (const row of this.db.prepare("SELECT record FROM assets WHERE asset_id=? AND state='ACTIVE'").all(assetId) as { record: string }[]) {
        const prior = JSON.parse(row.record) as AssetRevision; prior.state = "DEPRECATED";
        this.db.prepare("UPDATE assets SET state='DEPRECATED', record=? WHERE asset_id=? AND revision=?").run(JSON.stringify(prior), assetId, prior.revision);
      }
      candidate.state = "ACTIVE";
      this.db.prepare("UPDATE assets SET state='ACTIVE', record=? WHERE asset_id=? AND revision=?").run(JSON.stringify(candidate), assetId, revision);
      this.db.exec("COMMIT;"); return candidate;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  revoke(assetId: string, revision: string): AssetRevision {
    const record = this.getAsset(assetId, revision); record.state = "REVOKED";
    this.db.prepare("UPDATE assets SET state='REVOKED', record=? WHERE asset_id=? AND revision=?").run(JSON.stringify(record), assetId, revision);
    return record;
  }

  recordArtifact(input: ArtifactInput, bytes: Uint8Array): ArtifactRecord {
    const validated = artifactInput.parse(input);
    const record = { ...validated, ...this.blob(bytes) };
    if (this.db.prepare("SELECT 1 FROM artifacts WHERE artifact_id=?").get(record.artifactId)) throw new CompositionError("ARTIFACT_IMMUTABLE");
    this.db.prepare("INSERT INTO artifacts VALUES (?, ?)").run(record.artifactId, JSON.stringify(record));
    return record;
  }

  promoteExternalArtifact(source: Readonly<ArtifactPromotionSource>, input: Omit<AssetDraft, "source">): AssetRevision {
    this.assertOpen();
    const artifactId = id.parse(source.artifactId);
    const producerRun = id.parse(source.producerRun);
    if (!/^[a-f0-9]{64}$/.test(source.contentDigest) || !Number.isSafeInteger(source.size) || source.size < 0 || !(source.bytes instanceof Uint8Array)) throw new CompositionError("INVALID_ARTIFACT_PROMOTION_SOURCE");
    const bytes = Buffer.from(source.bytes);
    if (bytes.byteLength !== source.size || this.hash(bytes) !== source.contentDigest) throw new CompositionError("ARTIFACT_PROMOTION_DIGEST_MISMATCH");
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const record = { ...this.createDraft({ ...input, source: "artifact:" + artifactId }, bytes), promotedFromArtifactId: artifactId, promotedFromRunId: producerRun, promotedFromArtifactDigest: source.contentDigest };
      this.db.prepare("UPDATE assets SET record=? WHERE asset_id=? AND revision=?").run(JSON.stringify(record), record.assetId, record.revision);
      this.db.exec("COMMIT;");
      return record;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  resolveActive(assetId: string, revision: string, expectedDigest: string): { asset: AssetRevision; bytes: Buffer } {
    const record = this.getAsset(assetId, revision);
    if (record.state !== "ACTIVE" || record.contentDigest !== expectedDigest) throw new CompositionError("ASSET_NOT_ACTIVE");
    const bytes = this.readBlob(record.contentDigest);
    return { asset: structuredClone(record), bytes };
  }
  promoteArtifact(artifactId: string, input: AssetDraft): AssetRevision {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare("SELECT record FROM artifacts WHERE artifact_id=?").get(artifactId) as { record: string } | undefined;
      if (!row) throw new CompositionError("UNKNOWN_ARTIFACT");
      const artifact = JSON.parse(row.record) as ArtifactRecord;
      const record = { ...this.createDraft(input, this.readBlob(artifact.contentDigest)), promotedFromArtifactId: artifactId };
      this.db.prepare("UPDATE assets SET record=? WHERE asset_id=? AND revision=?").run(JSON.stringify(record), record.assetId, record.revision);
      this.db.exec("COMMIT;"); return record;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
