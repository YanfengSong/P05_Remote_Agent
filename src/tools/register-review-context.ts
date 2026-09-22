import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import type { ReferenceManager } from "../reference/manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { gitStatus } from "./git.js";
import { structuredResult } from "./result.js";

export function registerReviewContextTool(
  exposer: Exposer,
  workspaceManager: WorkspaceManager,
  referenceManager: ReferenceManager,
  slot: "A" | "B"
): void {
  exposer.expose("review_context", {
    description:
      "MANDATORY fresh-context check for reviewer tasks. Call this before reviewing current files, Git state or workspace facts. Returns the live Runtime binding and immutable read-only authority. It does not switch workspaces or control the Runtime.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      generatedAt: z.string(),
      role: z.literal("reviewer"),
      runtimeSlot: z.enum(["A", "B"]),
      profile: z.literal("readonly"),
      workspace: z.object({
        id: z.string(),
        kind: z.enum(["platform-source", "git-project", "generic"]),
        label: z.string().optional(),
        platform: z.boolean()
      }),
      gitStatus: z.string(),
      references: z.array(z.object({
        id: z.string(),
        label: z.string()
      })),
      authority: z.object({
        canSwitchWorkspace: z.literal(false),
        canControlRuntime: z.literal(false),
        canWrite: z.literal(false),
        canExecuteShell: z.literal(false),
        canMutateGit: z.literal(false),
        canInvokeDownstream: z.literal(false)
      })
    })
  }, async () => {
    const current = workspaceManager.current();
    let status: string;
    try {
      status = await gitStatus(current.root);
    } catch {
      status = "Git status unavailable for the current workspace.";
    }

    const output = {
      generatedAt: new Date().toISOString(),
      role: "reviewer" as const,
      runtimeSlot: slot,
      profile: "readonly" as const,
      workspace: {
        id: current.id,
        kind: current.kind,
        ...(current.label ? { label: current.label } : {}),
        platform: current.kind === "platform-source"
      },
      gitStatus: status,
      references: referenceManager.list().map(({ id, label }) => ({ id, label })),
      authority: {
        canSwitchWorkspace: false as const,
        canControlRuntime: false as const,
        canWrite: false as const,
        canExecuteShell: false as const,
        canMutateGit: false as const,
        canInvokeDownstream: false as const
      }
    };

    return structuredResult(output, JSON.stringify(output, null, 2));
  });
}
