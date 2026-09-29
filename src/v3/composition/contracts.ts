import { z } from "zod";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const serviceKeySchema = z.object({ name, version: name }).strict();
export interface ServiceKey<T = unknown> { name: string; version: string; readonly __type?: T }
export function createServiceKey<T>(name: string, version: string): ServiceKey<T> { return Object.freeze(serviceKeySchema.parse({ name, version })); }
export function keyId(key: ServiceKey): string { return `${key.name}@${key.version}`; }
export const componentManifestSchema = z.object({
  componentId: name,
  revision: name,
  entrypointDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configVersion: name,
  scope: z.enum(["platform", "workspace", "agent", "run", "shadow"]),
  hostCompatibility: z.array(z.enum(["win32", "linux", "darwin"])).min(1),
  provides: z.array(z.object({ key: serviceKeySchema, kind: z.enum(["single", "registry"]) }).strict()).max(64),
  requires: z.array(z.object({ key: serviceKeySchema, kind: z.enum(["single", "registry"]) }).strict()).max(64),
  effectOwnership: z.array(z.discriminatedUnion("effect", [
    z.object({ effect: z.literal("E1"), management: z.literal("fiber") }).strict(),
    z.object({ effect: z.enum(["E2", "E3", "E4"]), management: z.literal("external"), manager: name }).strict(),
  ])).max(32),
  activationPolicy: z.literal("desired"),
}).strict();
export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export type ScopeKind = ComponentManifest["scope"];
export interface CompositionScope { id: string; kind: ScopeKind; parentId?: string }
export type FiberState = "PENDING" | "ACTIVATING" | "ACTIVE" | "DRAINING" | "DISPOSING" | "DISPOSED" | "FAILED";
export interface ExternalEffectRecord { effect: "E2" | "E3" | "E4"; manager: string; state: "requested" | "applied" | "unknown"; reference: string }
export class CompositionError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "CompositionError"; }
}
