import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import type { ProtectionAssessment } from "./core/index.js";
import type { V3Config } from "./config.js";
import { verifyConfigurationProtection, verifyStateProtection } from "./protection.js";

const manifestSchema = z.object({
  version: z.literal(1),
  slotId: z.enum(["A", "B"]),
  workspaceId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  workspaceRoot: z.string().min(1),
  authorizationRevision: z.string().min(1).max(128),
  principal: z.string().min(1).max(128)
}).strict();

const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

export async function verifyBootstrapTrustManifest(filename: string | undefined, expected: V3Config): Promise<ProtectionAssessment> {
  if (!filename) return { verified: true, code: "TRUST_MANIFEST_NOT_CONFIGURED" };
  const requested = path.resolve(filename);
  if (!fs.existsSync(requested)) return { verified: false, code: "TRUST_MANIFEST_MISSING" };
  try {
    const canonical = fs.realpathSync(requested);
    const stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size > 64 * 1024) return { verified: false, code: "TRUST_MANIFEST_INVALID" };
    if (!(await verifyStateProtection(path.dirname(canonical))).verified || !(await verifyConfigurationProtection(canonical)).verified) {
      return { verified: false, code: "TRUST_MANIFEST_UNPROTECTED" };
    }
    const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(canonical, "utf8")));
    if (!path.isAbsolute(manifest.workspaceRoot)) return { verified: false, code: "TRUST_MANIFEST_INVALID" };
    const workspaceRoot = fs.realpathSync(manifest.workspaceRoot);
    const matches = manifest.slotId === expected.slotId &&
      manifest.workspaceId === expected.workspaceId &&
      manifest.authorizationRevision === expected.authorizationRevision &&
      manifest.principal === expected.principal &&
      normalize(workspaceRoot) === normalize(expected.workspaceRoot);
    return matches ? { verified: true, code: "TRUST_MANIFEST_VERIFIED" } : { verified: false, code: "TRUST_MANIFEST_MISMATCH" };
  } catch {
    return { verified: false, code: "TRUST_MANIFEST_INVALID" };
  }
}