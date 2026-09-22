export type { CapabilityDescriptor, CapabilityScope, ToolProfile, ToolRisk } from "./types.js";
import type { CapabilityDescriptor } from "./types.js";

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  { name: "device_info", minProfile: "discovery", risk: "read", scope: "platform", summary: "Identity and runtime information for this P05 computer." },
  { name: "ping", minProfile: "discovery", risk: "read", scope: "platform", summary: "Confirm this P05 computer is online and responding." },
  { name: "workspace_list", minProfile: "readonly", risk: "read", scope: "platform", summary: "List registered workspace identities without exposing host paths." },
  { name: "workspace_current", minProfile: "readonly", risk: "read", scope: "platform", summary: "Show the active workspace identity without exposing its host path." },
  { name: "reference_list", minProfile: "readonly", risk: "read", scope: "reference", summary: "List locally authorized read-only reference roots without exposing host paths." },
  { name: "reference_read", minProfile: "readonly", risk: "read", scope: "reference", summary: "Read a UTF-8 text file inside a locally authorized read-only reference root." },
  { name: "reference_list_directory", minProfile: "readonly", risk: "read", scope: "reference", summary: "List direct children inside a locally authorized read-only reference root." },
  { name: "activity_recent", minProfile: "readonly", risk: "read", scope: "platform", summary: "Show recent bounded execution metadata without tool inputs or secret content." },
  { name: "recovery_status", minProfile: "readonly", risk: "read", scope: "platform", summary: "Show failed or interrupted executions that may need recovery." },
  { name: "plugin_list", minProfile: "readonly", risk: "read", scope: "platform", summary: "List installed application plugins, versions and active-workspace availability." },

  { name: "fs_read", minProfile: "readonly", risk: "read", scope: "workspace", summary: "Read a UTF-8 text file inside the active workspace." },
  { name: "fs_list", minProfile: "readonly", risk: "read", scope: "workspace", summary: "List direct children of a directory inside the active workspace." },
  { name: "fs_write", minProfile: "developer", risk: "write", scope: "workspace", summary: "Create or replace a UTF-8 text file inside the active workspace." },
  { name: "apply_patch", minProfile: "developer", risk: "write", scope: "workspace", summary: "Patch one exact text occurrence with an expected SHA-256 concurrency guard." },

  { name: "git_status", minProfile: "readonly", risk: "read", scope: "workspace", summary: "Show branch and working-tree status for the active workspace." },
  { name: "git_diff", minProfile: "readonly", risk: "read", scope: "workspace", summary: "Show the current workspace Git diff without an external diff driver." },
  { name: "git_diff_stat", minProfile: "readonly", risk: "read", scope: "workspace", summary: "Show compact Git diff statistics for the active workspace." },
  { name: "git_add", minProfile: "developer", risk: "write", scope: "workspace", summary: "Stage explicit paths inside the active workspace." },
  { name: "git_commit", minProfile: "developer", risk: "write", scope: "workspace", summary: "Create a local Git commit in the active workspace." },
  { name: "git_branch", minProfile: "developer", risk: "write", scope: "workspace", summary: "Create, switch or safely delete a local branch in the active workspace." },
  { name: "git_push", minProfile: "full", risk: "write", scope: "external", summary: "Push the current branch to a named Git remote without force or arbitrary refspec." },

  { name: "command_run", minProfile: "developer", risk: "execute", scope: "platform", summary: "Run one server-side allowlisted P05 platform validation action." },
  { name: "runtime_restart", minProfile: "developer", risk: "execute", scope: "host", summary: "Restart only the current P05 runtime slot through the repo-local restart controller." },

  { name: "mcp_status", minProfile: "developer", risk: "read", scope: "downstream", summary: "Show configured downstream MCP servers and their connection state." },
  { name: "mcp_list_tools", minProfile: "developer", risk: "read", scope: "downstream", summary: "Connect to a downstream MCP server and list its tools." },
  { name: "mcp_call_tool", minProfile: "full", risk: "execute", scope: "downstream", summary: "Call an arbitrary tool on a downstream MCP server." },

  { name: "shell_run", minProfile: "developer", risk: "execute", scope: "workspace", summary: "Run PowerShell with the paired Windows user permissions; not a sandbox." }
];

export class CapabilityCatalog {
  readonly #entries = new Map<string, CapabilityDescriptor>();

  constructor(initial: readonly CapabilityDescriptor[] = CAPABILITIES) {
    this.registerMany(initial, "core");
  }

  registerMany(entries: readonly CapabilityDescriptor[], source: string): void {
    for (const entry of entries) {
      if (this.#entries.has(entry.name)) {
        throw new Error(`Duplicate capability "${entry.name}" from ${source}.`);
      }
      this.#entries.set(entry.name, { ...entry });
    }
  }

  descriptor(name: string): CapabilityDescriptor {
    const descriptor = this.#entries.get(name);
    if (!descriptor) throw new Error(`Capability "${name}" is not declared.`);
    return descriptor;
  }

  maybe(name: string): CapabilityDescriptor | undefined {
    const descriptor = this.#entries.get(name);
    return descriptor ? { ...descriptor } : undefined;
  }

  list(): CapabilityDescriptor[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }
}

export const DEFAULT_CAPABILITY_CATALOG = new CapabilityCatalog(CAPABILITIES);

export function capabilityDescriptor(name: string): CapabilityDescriptor {
  return DEFAULT_CAPABILITY_CATALOG.descriptor(name);
}

export function capabilityRegistry(): CapabilityDescriptor[] {
  return DEFAULT_CAPABILITY_CATALOG.list();
}