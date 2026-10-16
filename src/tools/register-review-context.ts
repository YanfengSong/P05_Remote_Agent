import * as z from "zod/v4";
import type { Exposer } from "../policy/expose.js";
import {
  PROFILE_RANK,
  type ToolProfile
} from "../policy/tool-profile.js";
import type { ReferenceManager } from "../reference/manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { gitStatus } from "./git.js";
import { structuredResult } from "./result.js";

export function registerReviewContextTool(
  exposer: Exposer,
  workspaceManager: WorkspaceManager,
  referenceManager: ReferenceManager,
  slot: "A" | "B",
  profile: ToolProfile
): void {
  const developerAuthority =
    PROFILE_RANK[profile] >= PROFILE_RANK.developer;
  exposer.expose("review_context", {
    description:
      "MANDATORY fresh-context check for reviewer tasks. Call this before reviewing current files, Git state or workspace facts. Returns the live Runtime binding and the active HTTP tool-profile authority.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      generatedAt: z.string(),
      role: z.literal("reviewer"),
      runtimeSlot: z.enum(["A", "B"]),
      profile: z.enum(["discovery", "readonly", "developer", "full"]),
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
        canControlRuntime: z.boolean(),
        canWrite: z.boolean(),
        canExecuteShell: z.boolean(),
        canMutateGit: z.boolean(),
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
      profile,
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
        canControlRuntime: developerAuthority,
        canWrite: developerAuthority,
        canExecuteShell: developerAuthority,
        canMutateGit: developerAuthority,
        canInvokeDownstream: false as const
      }
    };

    return structuredResult(output, JSON.stringify(output, null, 2));
  });
}
