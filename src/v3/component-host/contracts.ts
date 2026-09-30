import path from "node:path";
import { z } from "zod";
import { componentManifestSchema, serviceKeySchema } from "../composition/contracts.js";
import type { ComponentContext } from "../composition/runtime.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const absolute = z.string().min(1).max(2048).refine(path.isAbsolute);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const componentHostConfigSchema = z.object({
  version: z.literal(1), slotId: id, principalId: id, workspaceRoot: absolute,
  isolationMode: z.enum(["trusted-local-plugin", "node-permission"]).default("trusted-local-plugin"),
  maxResultBytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024),
  stateDir: absolute, installationRoot: absolute, port: z.number().int().min(0).max(65535).default(0),
  installations: z.array(z.object({ installationId: id, file: absolute, manifest: componentManifestSchema }).strict()).min(1).max(64),
  components: z.array(z.object({ componentId: id, installationId: id, config: z.unknown() }).strict()).min(1).max(32),
  capabilities: z.array(z.object({ capabilityId: id, componentId: id, key: serviceKeySchema, effect: z.enum(["E0", "E1"]), description: z.string().min(1).max(512) }).strict()).max(64),
  assets: z.array(z.object({ assetId: id, revision: id, file: absolute, digest, evidenceRef: z.string().min(1).max(512), operatorReviewed: z.literal(true), effects: z.array(z.enum(["E0", "E1", "E2", "E3", "E4"])).max(5) }).strict()).max(64).default([]),
}).strict();
type ParsedComponentHostConfig = z.output<typeof componentHostConfigSchema>;
export type ComponentHostConfig = Omit<ParsedComponentHostConfig, "isolationMode" | "maxResultBytes"> & Partial<Pick<ParsedComponentHostConfig, "isolationMode" | "maxResultBytes">>;
export interface InstalledComponentModule {
  createComponent(api: { z: typeof z }): {
    configSchema: z.ZodType;
    activate(context: ComponentContext, config: Readonly<unknown>): void | Promise<void>;
  };
}
/** Client input cannot override this server-selected identity. runId is audit-only. */
export interface ComponentCallContext {
  readonly slotId: string;
  readonly principalId: string;
  readonly workspaceRoot: string;
  readonly capabilityId: string;
  readonly effect: "E0" | "E1";
  readonly runId?: string;
}
export interface CallableComponentService {
  inputSchema: z.ZodType;
  invoke(input: unknown, context: Readonly<ComponentCallContext>): unknown | Promise<unknown>;
}
export class ComponentHostError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ComponentHostError"; }
}

export const callSchema = z.object({ capabilityId: id, input: z.unknown(), runId: id.optional(), expectedBindingId: z.string().uuid().optional() }).strict();
export const replaceSchema = z.object({ componentId: id, installationId: id, config: z.unknown(), expectedRevision: z.number().int().positive() }).strict();
export const desiredSchema = z.object({ componentId: id, enabled: z.boolean(), manualHold: z.boolean(), expectedRevision: z.number().int().positive() }).strict();
export const assetQuerySchema = z.object({ assetId: id, revision: id, expectedDigest: digest }).strict();
