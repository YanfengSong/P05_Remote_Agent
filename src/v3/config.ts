import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";

const schema = z.object({
  version: z.literal(1),
  slotId: z.enum(["A", "B"]),
  stateDir: z.string().min(1),
  workspaceId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  workspaceRoot: z.string().min(1),
  authorizationRevision: z.string().min(1).max(128),
  principal: z.string().min(1).max(128),
  port: z.number().int().min(0).max(65535).default(0),
  optionalRuntime: z.boolean().default(true),
  workflowCatalog: z.string().refine(path.isAbsolute).optional(),
  workflowAutoAdvance: z.boolean().default(true),
  processHostConnection: z.string().refine(path.isAbsolute).optional(),
  componentHostConnection: z.string().refine(path.isAbsolute).optional(),
  componentCapabilities: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/)).max(64).default([]),
  allowHostExecute: z.boolean().default(false),
  trustManifest: z.string().refine(path.isAbsolute).optional(),
  trustedHost: z.boolean().default(false),
  allowWrites: z.boolean().default(false)
}).strict();

export type V3Config = z.infer<typeof schema>;
export const V3_CONFIG_SCHEMA = schema;

/** This file is chosen by the local launcher; remote tool arguments cannot replace it. */
export function readV3Config(filename: string): V3Config {
  if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > 64 * 1024) throw new Error("CONFIGURATION_SIZE_INVALID");
  const config = schema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
  for (const key of ["stateDir", "workspaceRoot"] as const) {
    if (!path.isAbsolute(config[key])) throw new Error(`${key} must be absolute`);
    config[key] = path.resolve(config[key]);
  }
  config.workspaceRoot = fs.realpathSync(config.workspaceRoot);
  if (!fs.statSync(config.workspaceRoot).isDirectory()) throw new Error("Workspace must be a directory");
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(config.workspaceRoot), normalize(fs.realpathSync(filename)));
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Local authorization configuration must be outside the execution Workspace");
  }
  if (config.allowWrites && !config.trustedHost) {
    throw new Error("The initial file backend requires explicit trustedHost for writes; OS sandbox is not implemented");
  }
  if (config.allowHostExecute && (!config.trustedHost || !config.processHostConnection)) {
    throw new Error("Host execution requires explicit trustedHost and a protected Process Host connection");
  }
  return config;
}
