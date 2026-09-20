import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionContext } from "../runtime/context.js";
import { DurableRunKernel } from "../run/kernel.js";
import type { RunEvent, RunRecord } from "../run/types.js";
import { SqliteStateStore } from "../storage/sqlite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_run_kernel_test");
const DB = path.join(FIXTURE, "p05-v3.sqlite");

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}${detail ? " -> " + detail : ""}`);
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(FIXTURE, { recursive: true });

const context = createExecutionContext({
  workspace: { id: "kernel-test", root: FIXTURE },
  actor: { type: "system", id: "run-kernel-test" },
  profile: "developer"
});

const store = new SqliteStateStore(DB);
const kernel = new DurableRunKernel(store);

try {
  const created = kernel.create({
    id: "run-test-1",
    kind: "host-session",
    context,
    ownerType: "test",
    domain: { sessionState: "created", count: 0 }
  });
  check("run-kernel: create persists run", created.id === "run-test-1");
  check("run-kernel: create starts sequence at one", created.sequence === 1);
  check("run-kernel: create event persisted", kernel.events(created.id).length === 1);

  const running = kernel.transition(created.id, {
    state: "RUNNING",
    eventType: "session.running",
    domainPatch: { sessionState: "running", count: 1 },
    recoveryHint: "inspect"
  });
  check("run-kernel: transition updates snapshot", running.state === "RUNNING");
  check("run-kernel: transition increments sequence", running.sequence === 2);
  check("run-kernel: startedAt set on running", typeof running.startedAt === "string");
  check("run-kernel: domain patch persisted", running.domain.count === 1);
  check("run-kernel: event sequence monotonic",
    kernel.events(created.id).map((event) => event.sequence).join(",") === "1,2"
  );

  const reader = new SqliteStateStore(DB);
  try {
    const visible = reader.getRun(created.id);
    check("run-kernel: second WAL connection reads committed state", visible?.sequence === 2);
  } finally {
    reader.close();
  }

  const before = kernel.get(created.id);
  const invalidNext: RunRecord = {
    ...before,
    state: "SUCCEEDED",
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    sequence: before.sequence + 1
  };
  const duplicateEvent: RunEvent = {
    runId: before.id,
    sequence: 1,
    type: "invalid.duplicate",
    at: new Date().toISOString(),
    payload: {}
  };
  let rolledBack = false;
  try {
    store.updateRunAndAppendEvent(invalidNext, duplicateEvent);
  } catch {
    rolledBack = true;
  }
  check("run-kernel: duplicate event forces transaction failure", rolledBack);
  const afterRollback = kernel.get(created.id);
  check("run-kernel: failed event append rolls snapshot back",
    afterRollback.sequence === before.sequence && afterRollback.state === before.state,
    JSON.stringify(afterRollback)
  );

  const completed = kernel.transition(created.id, {
    state: "SUCCEEDED",
    eventType: "run.completed",
    domainPatch: { sessionState: "completed" },
    recoveryHint: "none"
  });
  check("run-kernel: terminal transition records finishedAt", typeof completed.finishedAt === "string");
  check("run-kernel: terminal event persisted", kernel.events(created.id).at(-1)?.type === "run.completed");

  store.close();
  const reopened = new SqliteStateStore(DB);
  try {
    const persisted = reopened.getRun(created.id);
    check("run-kernel: state survives reopen", persisted?.state === "SUCCEEDED");
    check("run-kernel: events survive reopen", reopened.listRunEvents(created.id).length === 3);
  } finally {
    reopened.close();
  }

  console.log(`RUN_KERNEL_OK (${checks} checks)`);
} finally {
  try { store.close(); } catch {}
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
