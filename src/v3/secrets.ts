import * as z from "zod/v4";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const secretArgumentSchema = z.object({
  $secretRef: id,
  prefix: z.string().max(4096).default(""),
  suffix: z.string().max(4096).default("")
}).strict();
export type SecretArgument = z.infer<typeof secretArgumentSchema>;
export type SecretExecutionContext = { principalId: string; workspaceId: string; purpose: "process-argument" };

export interface SecretResolver {
  resolveForExecution(reference: Readonly<SecretArgument>, context: Readonly<SecretExecutionContext>): Promise<string> | string;
}

export class SecretError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "SecretError"; }
}

type Entry = { principalId: string; workspaceId: string; value: string };

function bytePatterns(values: readonly string[]): Buffer[] {
  return [...new Set(values.filter(value => typeof value === "string" && value.length >= 4))]
    .map(value => Buffer.from(value, "utf8"))
    .filter(value => value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

export function redactSecretText(text: string, values: readonly string[]): string {
  let result = text;
  for (const secret of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function redactSecretBuffer(bytes: Buffer, values: readonly string[]): Buffer {
  const patterns = bytePatterns(values);
  if (!patterns.length || !bytes.length) return Buffer.from(bytes);
  const replacement = Buffer.from("[REDACTED]", "utf8");
  const pieces: Buffer[] = [];
  for (let index = 0; index < bytes.length;) {
    const match = patterns.find(pattern => index + pattern.length <= bytes.length && bytes.subarray(index, index + pattern.length).equals(pattern));
    if (match) { pieces.push(replacement); index += match.length; }
    else { pieces.push(bytes.subarray(index, index + 1)); index++; }
  }
  return Buffer.concat(pieces);
}

export function containsSecret(bytes: Buffer | string, values: readonly string[]): boolean {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return bytePatterns(values).some(pattern => buffer.indexOf(pattern) >= 0);
}

export class StreamingSecretRedactor {
  private pending = Buffer.alloc(0);
  private readonly patterns: Buffer[];
  private readonly maxLength: number;
  constructor(values: readonly string[]) {
    this.patterns = bytePatterns(values);
    this.maxLength = this.patterns.reduce((max, item) => Math.max(max, item.length), 0);
  }
  push(chunk: Buffer): Buffer {
    return this.consume(chunk, false);
  }
  flush(): Buffer {
    return this.consume(Buffer.alloc(0), true);
  }
  private consume(chunk: Buffer, final: boolean): Buffer {
    if (!this.patterns.length) return Buffer.from(chunk);
    const source = Buffer.concat([this.pending, chunk]);
    const safeBoundary = final ? source.length : Math.max(0, source.length - (this.maxLength - 1));
    const replacement = Buffer.from("[REDACTED]", "utf8");
    const output: Buffer[] = [];
    let index = 0;
    while (index < safeBoundary) {
      const match = this.patterns.find(pattern => index + pattern.length <= source.length && source.subarray(index, index + pattern.length).equals(pattern));
      if (match) { output.push(replacement); index += match.length; }
      else { output.push(source.subarray(index, index + 1)); index++; }
    }
    this.pending = Buffer.from(source.subarray(index));
    if (final && this.pending.length) {
      const tail = this.pending; this.pending = Buffer.alloc(0);
      return Buffer.concat([...output, redactSecretBuffer(tail, this.patterns.map(pattern => pattern.toString("utf8")))]);
    }
    return Buffer.concat(output);
  }
}

export class InMemorySecretManager implements SecretResolver {
  private readonly entries = new Map<string, Entry>();
  register(input: { secretId: string; principalId: string; workspaceId: string; value: string }): void {
    const secretId = id.parse(input.secretId), principalId = id.parse(input.principalId), workspaceId = id.parse(input.workspaceId);
    if (typeof input.value !== "string" || input.value.length < 4 || input.value.length > 4096 || input.value.includes("\0")) throw new SecretError("INVALID_SECRET_VALUE");
    if (this.entries.has(secretId)) throw new SecretError("SECRET_IMMUTABLE");
    this.entries.set(secretId, { principalId, workspaceId, value: input.value });
  }
  resolveForExecution(reference: Readonly<SecretArgument>, context: Readonly<SecretExecutionContext>): string {
    const parsed = secretArgumentSchema.parse(reference);
    const entry = this.entries.get(parsed.$secretRef);
    if (!entry || entry.principalId !== context.principalId || entry.workspaceId !== context.workspaceId || context.purpose !== "process-argument") {
      throw new SecretError("SECRET_NOT_FOUND");
    }
    return entry.value;
  }
  redactText(text: string): string { return redactSecretText(text, [...this.entries.values()].map(entry => entry.value)); }
  redactBuffer(bytes: Buffer): Buffer { return redactSecretBuffer(bytes, [...this.entries.values()].map(entry => entry.value)); }
  containsSecret(bytes: Buffer | string): boolean { return containsSecret(bytes, [...this.entries.values()].map(entry => entry.value)); }
  valuesForTrustedScan(): readonly string[] { return Object.freeze([...this.entries.values()].map(entry => entry.value)); }
}