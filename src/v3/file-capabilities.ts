import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { Capability, Invocation, Json, Run } from "./durable/types.js";

const inputPath = z.string().min(1).max(4096);
const readSchema = z.object({ path: inputPath }).strict();
const writeSchema = z.object({
  path: inputPath,
  content: z.string().max(48 * 1024),
  // Explicit expected contents are part of the approved intent. null means create-only.
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable()
}).strict();

/** Approval names a stable lexical target; a link cannot retarget that intent while it waits. */
async function rejectWriteLinks(workspaceRoot: string, input: string): Promise<void> {
  const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, input));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("INVALID_WRITE_TARGET");
  let current = workspaceRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("LINK_WRITE_TARGET_REFUSED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export const FILE_CAPABILITY_METADATA = [
  { capability: "fs_read", effect: "E0", authority: ["Read"], inputSchema: z.toJSONSchema(readSchema) },
  { capability: "fs_list", effect: "E0", authority: ["Read"], inputSchema: z.toJSONSchema(readSchema) },
  { capability: "fs_write", effect: "E3", authority: ["WorkspaceWrite"], inputSchema: z.toJSONSchema(writeSchema) }
] as const;

/** Reuse V2 guards and readers; load only after the launcher has set explicit roots. */
export async function createFileCapabilities(): Promise<Capability[]> {
  const files = await import("../tools/files.js");
  const { assertAccessiblePath } = await import("../security.js");
  const identity = { capabilityVersion: "1", bindingVersion: "v2-files-v3-adapter.1" };
  const assertInput = (capability: string, input: Json) => {
    if (capability === "fs_write") return writeSchema.parse(input);
    return readSchema.parse(input);
  };
  const capabilities: Capability[] = [
    {
      ...identity, capability: "fs_read",
      async execute({ run, input }) {
        const request = readSchema.parse(input);
        const text = await files.readTextFile(request.path, run.context.workspaceRoot);
        if (Buffer.byteLength(text) > 48 * 1024) throw new Error("OUTPUT_LIMIT: file requires pagination");
        return { text };
      }
    },
    {
      ...identity, capability: "fs_list",
      async execute({ run, input }) {
        const request = readSchema.parse(input);
        const entries = await files.listDirectory(request.path, run.context.workspaceRoot);
        if (Buffer.byteLength(JSON.stringify(entries)) > 48 * 1024) throw new Error("OUTPUT_LIMIT: directory requires pagination");
        return { entries };
      }
    },
    {
      ...identity, capability: "fs_write",
      async execute({ run, input, signal }) {
        const request = writeSchema.parse(input);
        await rejectWriteLinks(run.context.workspaceRoot, request.path);
        const target = await assertAccessiblePath(request.path, "write", run.context.workspaceRoot, run.context.workspaceRoot);
        if (signal.aborted) throw new Error("CANCELLED_BEFORE_WRITE");
        if (request.expectedSha256 === null) {
          // wx keeps a concurrent creator from being overwritten after approval.
          await fs.writeFile(target, request.content, { encoding: "utf8", flag: "wx" });
        } else {
          const current = await files.readTextFile(request.path, run.context.workspaceRoot);
          const actual = createHash("sha256").update(current).digest("hex");
          if (actual !== request.expectedSha256.toLowerCase()) throw new Error("PRECONDITION_FAILED");
          if (signal.aborted) throw new Error("CANCELLED_BEFORE_WRITE");
          // This trusted-host compatibility adapter is not an OS sandbox or atomic external CAS.
          await files.writeTextFile(request.path, request.content, run.context.workspaceRoot);
        }
        const actual = await files.readTextFile(request.path, run.context.workspaceRoot);
        const digest = createHash("sha256").update(request.content).digest("hex");
        if (createHash("sha256").update(actual).digest("hex") !== digest) throw new Error("POSTCONDITION_FAILED");
        return { bytes: Buffer.byteLength(request.content), sha256: digest };
      }
    }
  ];
  return capabilities.map(capability => ({
    ...capability,
    async execute(invocation: Invocation) {
      assertInput(capability.capability, invocation.input);
      return capability.execute(invocation);
    }
  }));
}

export function validateFileInput(capability: string, input: Json): void {
  if (capability === "fs_write") writeSchema.parse(input);
  else if (capability === "fs_read" || capability === "fs_list") readSchema.parse(input);
  else throw new Error("UNKNOWN_CAPABILITY");
}

export async function validateFileTarget(capability: string, input: Json, workspaceRoot: string): Promise<void> {
  if (capability === "fs_write") await rejectWriteLinks(workspaceRoot, writeSchema.parse(input).path);
}

export function publicRun(run: Run): object {
  const { workspaceRoot: _root, ...context } = run.context;
  return { ...run, context, error: run.error ? "EXECUTION_FAILED: inspect local execution diagnostics" : null };
}
