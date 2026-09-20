import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchRuntime } from "../search/runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_search_runtime_test");
const WS_A = path.join(FIXTURE, "workspace-a");
const WS_B = path.join(FIXTURE, "workspace-b");
const STATE = path.join(FIXTURE, "search-sessions.json");
const RECOVERY = path.join(FIXTURE, "recovery.json");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

async function rejects(
  label: string,
  fn: () => Promise<unknown> | unknown,
  mustContain?: string
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, mustContain ? message.includes(mustContain) : true, message);
    return;
  }
  throw new Error(`FAIL ${label} -> expected rejection`);
}

async function waitDone(runtime: SearchRuntime, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runtime.status(id);
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Search ${id} did not finish within ${timeoutMs} ms.`);
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(path.join(WS_A, "src"), { recursive: true });
await fs.mkdir(path.join(WS_A, "nested"), { recursive: true });
await fs.mkdir(WS_B, { recursive: true });

await fs.writeFile(
  path.join(WS_A, "src", "alpha.txt"),
  "first Needle line\nsecond line\nthird needle line\n",
  "utf8"
);
await fs.writeFile(
  path.join(WS_A, "nested", "BetaFile.txt"),
  "another needle value\n",
  "utf8"
);
await fs.writeFile(
  path.join(WS_A, ".env"),
  "SEARCH_SECRET_NEEDLE=must-not-be-indexed\n",
  "utf8"
);
await fs.writeFile(path.join(WS_B, "other.txt"), "needle in B\n", "utf8");

for (let i = 0; i < 60; i += 1) {
  await fs.writeFile(
    path.join(WS_A, "nested", `bulk-${String(i).padStart(3, "0")}.txt`),
    `bulk needle ${i}\n`,
    "utf8"
  );
}

let active = { id: "a", root: WS_A };
const runtime = new SearchRuntime(STATE, () => active);

try {
  const textSearch = await runtime.start({
    mode: "text",
    query: "needle",
    maxResults: 200
  });
  const textDone = await waitDone(runtime, textSearch.id);
  check("search: text search completes", textDone.state === "completed", textDone.state);
  check("search: text search has results", textDone.resultCount >= 63, String(textDone.resultCount));

  const firstPage = runtime.page(textSearch.id, 0, 2);
  check("search: page respects limit", firstPage.results.length === 2, JSON.stringify(firstPage));
  check("search: cursor advances", firstPage.nextCursor === 2, String(firstPage.nextCursor));
  const secondPage = runtime.page(textSearch.id, firstPage.nextCursor, 2);
  check("search: next page continues", secondPage.results[0]?.index === 2, JSON.stringify(secondPage));

  const all = runtime.page(textSearch.id, 0, 200);
  check(
    "search: protected .env content is skipped",
    all.results.every((result) => result.path !== ".env"),
    JSON.stringify(all.results.filter((result) => result.path === ".env"))
  );
  check(
    "search: line metadata is present for text mode",
    all.results.some((result) => result.path === "src/alpha.txt" && result.line === 1 && result.column !== undefined)
  );

  const nameSearch = await runtime.start({
    mode: "name",
    query: "betafile"
  });
  await waitDone(runtime, nameSearch.id);
  const namePage = runtime.page(nameSearch.id, 0, 20);
  check(
    "search: name mode is case-insensitive by default",
    namePage.results.some((result) => result.path === "nested/BetaFile.txt"),
    JSON.stringify(namePage)
  );

  const caseSearch = await runtime.start({
    mode: "name",
    query: "betafile",
    caseSensitive: true
  });
  await waitDone(runtime, caseSearch.id);
  check(
    "search: case-sensitive mode is honored",
    runtime.page(caseSearch.id, 0, 20).results.length === 0
  );

  const limitedSearch = await runtime.start({
    mode: "text",
    query: "needle",
    maxResults: 1
  });
  const limitedDone = await waitDone(runtime, limitedSearch.id);
  check("search: max-results marks limited", limitedDone.limited);
  check("search: max-results reason recorded", limitedDone.limitReason === "max-results");
  check("search: max-results is enforced", limitedDone.resultCount === 1, String(limitedDone.resultCount));

  const stopSearch = await runtime.start({
    mode: "text",
    query: "bulk",
    maxResults: 5000
  });
  runtime.stop(stopSearch.id);
  const stopped = await waitDone(runtime, stopSearch.id);
  check("search: stop transitions out of running", stopped.state === "stopped" || stopped.state === "completed", stopped.state);

  const stateText = await fs.readFile(STATE, "utf8");
  check("search: state persists metadata", stateText.includes(textSearch.id));
  check("search: state does not persist query", !stateText.toLowerCase().includes('"needle"'), stateText);
  check("search: state does not persist result preview", !stateText.includes("first Needle line"), stateText);

  const cross = await runtime.start({
    mode: "name",
    query: "alpha"
  });
  active = { id: "b", root: WS_B };
  await rejects(
    "search: session access cannot cross workspace",
    () => runtime.status(cross.id),
    'belongs to workspace "a"'
  );
  await rejects(
    "search: root cannot point at another workspace",
    () => runtime.start({
      mode: "name",
      query: "alpha",
      path: WS_A
    }),
    "outside the active workspace"
  );

  active = { id: "a", root: WS_A };
  await waitDone(runtime, cross.id);

  const staleId = "search-stale-running";
  await fs.writeFile(RECOVERY, JSON.stringify({
    version: 1,
    sessions: [{
      id: staleId,
      workspaceId: "a",
      mode: "text",
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      resultCount: 5,
      scannedFiles: 10,
      limited: false
    }]
  }, null, 2), "utf8");

  const recovered = new SearchRuntime(RECOVERY, () => active);
  const recoveredStatus = recovered.status(staleId);
  check("search: stale running state becomes interrupted", recoveredStatus.state === "interrupted");
  check("search: interrupted state is explainable", recoveredStatus.error?.includes("interrupted") === true);

  console.log(`SEARCH_RUNTIME_OK (${checks} checks)`);
} finally {
  runtime.interruptAll();
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
