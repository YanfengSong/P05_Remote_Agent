import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const rawSlot = String(process.argv[2] ?? "").trim().toUpperCase();
if (rawSlot !== "A" && rawSlot !== "B") {
  throw new Error("Runtime slot must be A or B.");
}

const slot = rawSlot.toLowerCase();
const stateDir = path.join(repoRoot, ".p05", `runtime-${slot}`, "state");
fs.mkdirSync(stateDir, { recursive: true });

process.env.P05_RUNTIME_SLOT = rawSlot;
process.env.P05_STATE_DIR = stateDir;

const bindingFile = path.join(stateDir, "active-workspace.txt");
if (fs.existsSync(bindingFile)) {
  const workspaceId = fs.readFileSync(bindingFile, "utf8").trim();
  if (workspaceId) process.env.P05_ACTIVE_WORKSPACE_ID = workspaceId;
}

const profileStatePath = path.join(stateDir, "tool-profile.json");
delete process.env.P05_TOOL_PROFILE_SOURCE;
if (fs.existsSync(profileStatePath)) {
  const parsed = JSON.parse(fs.readFileSync(profileStatePath, "utf8"));
  const profile = typeof parsed?.profile === "string" ? parsed.profile.trim().toLowerCase() : "";
  const knownProfiles = new Set(["discovery", "readonly", "developer", "full"]);
  if (!knownProfiles.has(profile)) {
    throw new Error(
      `Invalid Runtime ${rawSlot} tool profile in ${profileStatePath}. Expected one of: discovery, readonly, developer, full.`
    );
  }
  process.env.P05_TOOL_PROFILE = profile;
  process.env.P05_TOOL_PROFILE_SOURCE = "runtime-state";
}

await import(pathToFileURL(path.join(repoRoot, "dist", "index.js")).href);
