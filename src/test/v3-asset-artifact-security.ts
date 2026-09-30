import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore, ArtifactStoreError } from "../v3/artifacts.js";
import { AssetStore } from "../v3/composition/assets.js";
import { CompositionError } from "../v3/composition/contracts.js";

const root = mkdtempSync(path.join(os.tmpdir(), "p05-v3-t67-"));
const artifactRoot = path.join(root, "artifacts");
const assetRoot = path.join(root, "assets");
let now = 1_000;
const artifacts = new ArtifactStore({ root: artifactRoot, now: () => now, defaultRetentionMs: 0 });
let evidenceAllowed = false;
const assets = new AssetStore(assetRoot, async () => evidenceAllowed);
const alice = { principalId: "alice", workspaceId: "workspace-a" };
const bob = { principalId: "bob", workspaceId: "workspace-a" };
const carol = { principalId: "carol", workspaceId: "workspace-b" };
const artifactCode = (code: string) => (error: unknown) => error instanceof ArtifactStoreError && error.code === code;
const compositionCode = (code: string) => (error: unknown) => error instanceof CompositionError && error.code === code;

try {
  const privateArtifact = artifacts.publish({
    producerRun: "run-private",
    principalId: alice.principalId,
    workspaceId: alice.workspaceId,
    visibility: "private",
    mediaType: "text/plain",
    content: "reviewed-template"
  });
  const workspaceArtifact = artifacts.publish({
    producerRun: "run-workspace",
    principalId: alice.principalId,
    workspaceId: alice.workspaceId,
    visibility: "workspace",
    mediaType: "text/plain",
    content: "workspace-visible"
  });

  assert.equal(artifacts.read(alice, privateArtifact.artifactId).toString(), "reviewed-template");
  assert.throws(() => artifacts.get(bob, privateArtifact.artifactId), artifactCode("ARTIFACT_NOT_FOUND"), "same-workspace different principal cannot query private Artifact");
  assert.throws(() => artifacts.read(bob, privateArtifact.artifactId), artifactCode("ARTIFACT_NOT_FOUND"));
  assert.equal(artifacts.read(bob, workspaceArtifact.artifactId).toString(), "workspace-visible", "workspace-visible Artifact can be read by another principal in the same workspace");
  assert.throws(() => artifacts.read(carol, workspaceArtifact.artifactId), artifactCode("ARTIFACT_NOT_FOUND"), "knowing artifactId does not cross workspace ACL");

  const tampered = artifacts.publish({
    producerRun: "run-tamper",
    principalId: alice.principalId,
    workspaceId: alice.workspaceId,
    visibility: "private",
    mediaType: "text/plain",
    content: "original-artifact"
  });
  const tamperedPath = path.join(artifactRoot, "blobs", tampered.digest.slice(0, 2), tampered.digest.slice(2));
  writeFileSync(tamperedPath, "replaced-artifact");
  assert.throws(() => artifacts.read(alice, tampered.artifactId), artifactCode("ARTIFACT_BLOB_CORRUPT"), "Artifact digest replacement is detected before content is returned");

  const source = artifacts.claimForAsset(alice, privateArtifact.artifactId);
  assert.equal(artifacts.get(alice, privateArtifact.artifactId).protections.includes("asset-source"), true, "promotion claim creates a GC protection");
  artifacts.completeRun("run-private");
  now++;
  const protectedGc = artifacts.gc({ maxScan: 20, maxDelete: 20 });
  assert.equal(protectedGc.deletedArtifacts >= 0, true);
  assert.equal(artifacts.read(alice, privateArtifact.artifactId).toString(), "reviewed-template", "completed source Artifact survives GC while referenced by Asset promotion");

  const forged = { ...source, bytes: Buffer.from("forged-promotion") };
  assert.throws(() => assets.promoteExternalArtifact(forged, {
    assetId: "template-forged",
    revision: "1",
    author: "alice",
    effects: []
  }), compositionCode("ARTIFACT_PROMOTION_DIGEST_MISMATCH"), "promotion receipt cannot substitute different bytes");

  const promoted = assets.promoteExternalArtifact(source, {
    assetId: "template",
    revision: "1",
    author: "alice",
    effects: []
  });
  assert.equal(promoted.state, "DRAFT");
  assert.equal(promoted.source, "artifact:" + privateArtifact.artifactId);
  assert.equal(promoted.promotedFromArtifactId, privateArtifact.artifactId);
  assert.equal(promoted.promotedFromRunId, "run-private");
  assert.equal(promoted.promotedFromArtifactDigest, privateArtifact.digest);
  assert.equal(promoted.contentDigest, privateArtifact.digest);

  assert.throws(() => assets.resolveActive("template", "1", promoted.contentDigest), compositionCode("ASSET_NOT_ACTIVE"), "DRAFT Asset cannot execute");
  await assert.rejects(assets.verify("template", "1", promoted.contentDigest, "unproven"), compositionCode("ASSET_VERIFICATION_NOT_PROVEN"));
  evidenceAllowed = true;
  const verified = await assets.verify("template", "1", promoted.contentDigest, "verified:t67");
  assert.equal(verified.state, "VERIFIED");
  assert.throws(() => assets.resolveActive("template", "1", promoted.contentDigest), compositionCode("ASSET_NOT_ACTIVE"), "VERIFIED but not ACTIVE Asset cannot execute");

  const active = assets.activate("template", "1", promoted.contentDigest);
  assert.equal(active.state, "ACTIVE");
  assert.equal(assets.resolveActive("template", "1", promoted.contentDigest).bytes.toString(), "reviewed-template");
  assert.throws(() => assets.resolveActive("template", "1", "0".repeat(64)), compositionCode("ASSET_NOT_ACTIVE"), "execution must pin the exact active digest");

  const assetBlob = path.join(assetRoot, "blobs", promoted.contentDigest);
  writeFileSync(assetBlob, "asset-replaced-after-activation");
  assert.throws(() => assets.resolveActive("template", "1", promoted.contentDigest), compositionCode("ASSET_CONTENT_CORRUPTED"), "active Asset bytes are re-hashed at execution resolution");
  writeFileSync(assetBlob, source.bytes);

  assets.revoke("template", "1");
  assert.throws(() => assets.resolveActive("template", "1", promoted.contentDigest), compositionCode("ASSET_NOT_ACTIVE"), "REVOKED Asset cannot execute");
  assert.equal(artifacts.get(alice, privateArtifact.artifactId).protections.includes("asset-source"), true);

  artifacts.releaseAssetSource(alice, privateArtifact.artifactId);
  assert.equal(artifacts.get(alice, privateArtifact.artifactId).protections.includes("asset-source"), false);
  now++;
  artifacts.gc({ maxScan: 50, maxDelete: 50 });
  assert.throws(() => artifacts.get(alice, privateArtifact.artifactId), artifactCode("ARTIFACT_NOT_FOUND"), "source Artifact becomes collectable only after Asset reference is explicitly released");

  console.log("V3_T67_ASSET_ARTIFACT_SECURITY_OK (digest substitution rejected, principal/workspace ACL enforced, promotion provenance pinned, inactive/revoked execution denied, active-source GC protection and cleanup)");
} finally {
  assets.close();
  artifacts.close();
  rmSync(root, { recursive: true, force: true });
}