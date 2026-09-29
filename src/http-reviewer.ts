import path from "node:path";

const slotRaw = (process.env.P05_HTTP_REVIEWER_SLOT ?? "B").trim().toUpperCase();
if (slotRaw !== "A" && slotRaw !== "B") {
  throw new Error("P05_HTTP_REVIEWER_SLOT must be A or B.");
}
const slot = slotRaw as "A" | "B";

const stateDir = path.resolve(
  process.env.P05_HTTP_REVIEWER_STATE_DIR?.trim() ||
    path.join(process.cwd(), ".p05", `runtime-${slot.toLowerCase()}`, "state")
);

// device/identity.ts binds P05_STATE_DIR at module load time, so set it before
// dynamically importing the reviewer runtime.
process.env.P05_STATE_DIR = stateDir;
process.env.P05_TOOL_PROFILE = "readonly";

const { startReviewerHttpServer } = await import("./http/reviewer.js");
const reviewer = await startReviewerHttpServer({ slot, stateDir });

process.stderr.write(
  JSON.stringify({
    event: "p05.http_reviewer_ready",
    url: reviewer.url,
    slot: reviewer.slot,
    profile: reviewer.profile,
    tokenFile: reviewer.tokenFile,
    oauthClientFile: reviewer.oauthClientFile,
    oauthClientId: reviewer.oauthClientId
  }) + "\n"
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await reviewer.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
