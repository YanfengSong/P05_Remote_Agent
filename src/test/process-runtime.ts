import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPowerShellDriver } from "../process/drivers/local-powershell.js";
import { ProcessRuntime } from "../process/runtime.js";
import { createExecutionContext, type ExecutionContext } from "../runtime/context.js";
import { SessionManager } from "../session/manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIXTURE = path.join(REPO, "_p05_process_runtime_test");
const WS_A = path.join(FIXTURE, "workspace-a");
const WS_B = path.join(FIXTURE, "workspace-b");
const STATE = path.join(FIXTURE, "sessions.json");
const RECOVERY_STATE = path.join(FIXTURE, "recovery.json");

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await fs.rm(FIXTURE, { recursive: true, force: true });
await fs.mkdir(WS_A, { recursive: true });
await fs.mkdir(WS_B, { recursive: true });

let active = { id: "a", root: WS_A };
const contextFor = (workspace = active): ExecutionContext => createExecutionContext({
  workspace,
  actor: { type: "interactive", id: "process-test" },
  profile: "developer"
});

const sessions = new SessionManager(STATE);
const driver = new LocalPowerShellDriver();
const runtime = new ProcessRuntime(sessions, driver, () => contextFor());

try {
  const command = await runtime.start({
    mode: "command",
    command: "Write-Output 'proc-out'; [Console]::Error.WriteLine('proc-err'); exit 7"
  });
  check("process: command session starts in active workspace", command.workspaceId === "a");
  check("process: generic session id is assigned", command.id.startsWith("session-"), command.id);

  const commandWait = await runtime.wait(command.id, 10_000);
  check("process: command completes", commandWait.completed, JSON.stringify(commandWait));
  check("process: command exit code preserved", commandWait.exitCode === 7, JSON.stringify(commandWait));

  const commandOutput = runtime.output(command.id);
  const stdout = commandOutput.events
    .filter((event) => event.stream === "stdout")
    .map((event) => event.text)
    .join("");
  const stderr = commandOutput.events
    .filter((event) => event.stream === "stderr")
    .map((event) => event.text)
    .join("");
  check("process: stdout captured", stdout.includes("proc-out"), stdout);
  check("process: stderr captured", stderr.includes("proc-err"), stderr);
  check("process: output cursor advances", commandOutput.nextCursor > 0);

  const terminal = await runtime.start({
    mode: "terminal",
    command: "Write-Output 'terminal-ready'"
  });
  await sleep(600);
  const first = runtime.output(terminal.id);
  check(
    "terminal: initial command output captured",
    first.events.some((event) => event.text.includes("terminal-ready")),
    JSON.stringify(first)
  );

  await runtime.input(terminal.id, "Write-Output 'terminal-input'");
  await sleep(600);
  const second = runtime.output(terminal.id, first.nextCursor);
  check(
    "terminal: incremental input/output works",
    second.events.some((event) => event.text.includes("terminal-input")),
    JSON.stringify(second)
  );
  check(
    "terminal: cursor is monotonic",
    second.nextCursor >= first.nextCursor,
    `${first.nextCursor} -> ${second.nextCursor}`
  );

  await runtime.input(terminal.id, "exit");
  const terminalWait = await runtime.wait(terminal.id, 10_000);
  check("terminal: exit completes session", terminalWait.completed, JSON.stringify(terminalWait));

  const capturedA = contextFor({ id: "a", root: WS_A });
  const sleeper = await runtime.startWithContext(capturedA, {
    mode: "command",
    command: "Start-Sleep -Seconds 30"
  });

  active = { id: "b", root: WS_B };
  await rejects(
    "process: interactive access cannot cross workspace",
    () => runtime.view(sleeper.id),
    'belongs to workspace "a"'
  );
  check(
    "process: captured context remains valid after global workspace switch",
    runtime.viewWithContext(capturedA, sleeper.id).workspaceId === "a"
  );

  const capturedCommand = await runtime.startWithContext(capturedA, {
    mode: "command",
    command: "Write-Output (Get-Location).Path"
  });
  await runtime.waitWithContext(capturedA, capturedCommand.id, 10_000);
  const capturedOutput = runtime.outputWithContext(capturedA, capturedCommand.id);
  check(
    "process: captured context cwd is not retargeted by workspace switch",
    capturedOutput.events.some((event) =>
      event.stream === "stdout" && event.text.toLowerCase().includes("workspace-a")
    ),
    JSON.stringify(capturedOutput)
  );

  await rejects(
    "process: interactive cwd cannot point at another workspace",
    () => runtime.start({
      mode: "command",
      command: "Write-Output nope",
      cwd: WS_A
    }),
    "outside the active workspace"
  );

  active = { id: "a", root: WS_A };
  const stopped = await runtime.stop(sleeper.id, true);
  check("process: force stop records stopped state", stopped.state === "stopped", stopped.state);

  const stateText = await fs.readFile(STATE, "utf8");
  check("session: state persists metadata", stateText.includes(command.id));
  check("session: state does not persist command text", !stateText.includes("proc-out"), stateText);
  check("session: state does not persist terminal input", !stateText.includes("terminal-input"), stateText);
  check("session: state does not persist captured stderr", !stateText.includes("proc-err"), stateText);

  const staleId = "session-stale-running";
  const staleContext = contextFor({ id: "a", root: WS_A });
  await fs.writeFile(RECOVERY_STATE, JSON.stringify({
    version: 1,
    sessions: [{
      id: staleId,
      kind: "process",
      driverId: "local-powershell",
      context: { ...staleContext, sessionId: staleId },
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.500Z",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      recoveryHint: "inspect",
      attributes: { mode: "command", pid: 999999, completion: "running" }
    }]
  }, null, 2), "utf8");

  const recoveredSessions = new SessionManager(RECOVERY_STATE);
  const recovered = new ProcessRuntime(
    recoveredSessions,
    new LocalPowerShellDriver(),
    () => contextFor({ id: "a", root: WS_A })
  );
  const recoveredView = recovered.view(staleId);
  check("session: stale running session becomes interrupted", recoveredView.state === "interrupted");
  check("session: interrupted session remains inspectable", recoveredView.recoveryHint === "inspect");

  console.log(`PROCESS_RUNTIME_OK (${checks} checks)`);
} finally {
  active = { id: "a", root: WS_A };
  await runtime.interruptAll().catch(() => undefined);
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
}
