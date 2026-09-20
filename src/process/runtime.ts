import { assertAccessiblePath } from "../security.js";
import type { ExecutionContext } from "../runtime/context.js";
import { attachExecutionCorrelation } from "../runtime/execution.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionRecord } from "../session/types.js";
import type {
  ProcessDriver,
  ProcessDriverHandle
} from "./driver.js";
import type {
  ProcessMode,
  ProcessOutputEvent,
  ProcessOutputView,
  ProcessSessionView,
  ProcessState,
  ProcessWaitView
} from "./types.js";

const MAX_SESSIONS = 100;
const MAX_OUTPUT_CHARS = 64 * 1024;

function isSessionTerminal(state: SessionRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function processState(record: SessionRecord): ProcessState {
  switch (record.state) {
    case "created":
    case "starting":
      return "starting";
    case "running":
    case "stopping":
      return "running";
    case "completed":
      return record.attributes.completion === "stopped" ? "stopped" : "exited";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

function processMode(record: SessionRecord): ProcessMode {
  return record.attributes.mode === "terminal" ? "terminal" : "command";
}

function exitCode(record: SessionRecord): number | null | undefined {
  const value = record.attributes.exitCode;
  return typeof value === "number" || value === null ? value : undefined;
}

function executionRoot(context: ExecutionContext): string {
  return context.isolation?.root ?? context.workspaceRoot;
}

export class ProcessRuntime {
  readonly #sessions: SessionManager;
  readonly #driver: ProcessDriver;
  readonly #interactiveContext: () => ExecutionContext;
  readonly #handles = new Map<string, ProcessDriverHandle>();

  constructor(
    sessions: SessionManager,
    driver: ProcessDriver,
    interactiveContext: () => ExecutionContext
  ) {
    this.#sessions = sessions;
    this.#driver = driver;
    this.#interactiveContext = interactiveContext;
  }

  #assertAccess(id: string, caller: ExecutionContext): SessionRecord {
    const record = this.#sessions.get(id);
    if (record.kind !== "process") {
      throw new Error('Session "' + id + '" is not a process session.');
    }
    if (record.context.workspaceId !== caller.workspaceId) {
      throw new Error(
        'Process session "' + id + '" belongs to workspace "' +
        record.context.workspaceId + '", not workspace "' + caller.workspaceId + '".'
      );
    }

    if (caller.actor.type !== "interactive") {
      if (
        record.context.actor.type !== caller.actor.type ||
        record.context.actor.id !== caller.actor.id
      ) {
        throw new Error('Process session "' + id + '" belongs to a different execution actor.');
      }
    }
    return record;
  }

  #viewRecord(record: SessionRecord): ProcessSessionView {
    const code = exitCode(record);
    const pid = record.attributes.pid;
    return {
      id: record.id,
      workspaceId: record.context.workspaceId,
      mode: processMode(record),
      state: processState(record),
      ...(typeof pid === "number" ? { pid } : {}),
      startedAt: record.startedAt ?? record.createdAt,
      lastActivityAt: record.lastActivityAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(code !== undefined ? { exitCode: code } : {}),
      recoveryHint: record.recoveryHint,
      bufferedEvents: this.#sessions.bufferedEventCount(record.id)
    };
  }

  async start(args: {
    mode: ProcessMode;
    command?: string;
    cwd?: string;
  }): Promise<ProcessSessionView> {
    return this.startWithContext(this.#interactiveContext(), args);
  }

  async startWithContext(
    context: ExecutionContext,
    args: { mode: ProcessMode; command?: string; cwd?: string }
  ): Promise<ProcessSessionView> {
    const activeCount = this.#sessions.list({ kind: "process" })
      .filter((record) => !isSessionTerminal(record.state))
      .length;
    if (activeCount >= MAX_SESSIONS) {
      throw new Error("Too many active process sessions (limit " + MAX_SESSIONS + ").");
    }

    if (args.mode === "command" && !args.command?.trim()) {
      throw new Error("process_start command mode requires a non-blank command.");
    }

    const root = executionRoot(context);
    const safeCwd = await assertAccessiblePath(
      args.cwd ?? root,
      "read",
      root,
      root
    );

    const session = this.#sessions.create({
      kind: "process",
      driverId: this.#driver.id,
      context,
      attributes: {
        mode: args.mode,
        completion: "running"
      }
    });
    this.#sessions.transition(session.id, "starting");
    attachExecutionCorrelation({
      sessionId: session.id,
      actorType: session.context.actor.type,
      actorId: session.context.actor.id,
      taskId: session.context.taskId
    });

    const sink = {
      stdout: (text: string) => {
        this.#sessions.appendEvent(session.id, "stdout", text);
      },
      stderr: (text: string) => {
        this.#sessions.appendEvent(session.id, "stderr", text);
      },
      exit: (code: number | null) => {
        let current: SessionRecord;
        try { current = this.#sessions.get(session.id); } catch { return; }
        if (isSessionTerminal(current.state)) return;

        const stopped = current.state === "stopping" ||
          current.attributes.stopRequested === true;
        this.#sessions.transition(session.id, "completed", {
          recoveryHint: stopped || code !== 0 ? "inspect" : "none",
          attributes: {
            completion: stopped ? "stopped" : "exited",
            exitCode: code,
            pid: null
          }
        });
        this.#handles.delete(session.id);
      },
      error: (error: Error) => {
        this.#sessions.appendEvent(
          session.id,
          "stderr",
          "Process driver error: " + error.message + "\n"
        );
        let current: SessionRecord;
        try { current = this.#sessions.get(session.id); } catch { return; }
        if (!isSessionTerminal(current.state)) {
          this.#sessions.transition(session.id, "failed", {
            recoveryHint: "inspect",
            attributes: {
              completion: "failed",
              exitCode: null,
              pid: null
            }
          });
        }
        this.#handles.delete(session.id);
      }
    };

    try {
      const handle = await this.#driver.start({
        mode: args.mode,
        command: args.command,
        cwd: safeCwd
      }, sink);

      const afterStart = this.#sessions.get(session.id);
      if (!isSessionTerminal(afterStart.state)) {
        this.#handles.set(session.id, handle);
        this.#sessions.transition(session.id, "running", {
          recoveryHint: "inspect",
          attributes: {
            ...(typeof handle.pid === "number" ? { pid: handle.pid } : {}),
            completion: "running"
          }
        });
      }
      return this.viewWithContext(context, session.id);
    } catch (error) {
      const current = this.#sessions.get(session.id);
      if (!isSessionTerminal(current.state)) {
        this.#sessions.transition(session.id, "failed", {
          recoveryHint: "inspect",
          attributes: { completion: "failed", exitCode: null, pid: null }
        });
      }
      throw error;
    }
  }

  view(id: string): ProcessSessionView {
    return this.viewWithContext(this.#interactiveContext(), id);
  }

  viewWithContext(context: ExecutionContext, id: string): ProcessSessionView {
    return this.#viewRecord(this.#assertAccess(id, context));
  }

  list(): ProcessSessionView[] {
    return this.listWithContext(this.#interactiveContext());
  }

  listWithContext(context: ExecutionContext): ProcessSessionView[] {
    return this.#sessions.list({ workspaceId: context.workspaceId, kind: "process" })
      .filter((record) =>
        context.actor.type === "interactive" ||
        (record.context.actor.type === context.actor.type &&
          record.context.actor.id === context.actor.id)
      )
      .map((record) => this.#viewRecord(record));
  }

  async input(
    id: string,
    input: string,
    appendNewline = true
  ): Promise<ProcessSessionView> {
    return this.inputWithContext(this.#interactiveContext(), id, input, appendNewline);
  }

  async inputWithContext(
    context: ExecutionContext,
    id: string,
    input: string,
    appendNewline = true
  ): Promise<ProcessSessionView> {
    const record = this.#assertAccess(id, context);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    if (record.state !== "running") {
      throw new Error('Process session "' + id + '" is not running.');
    }
    const handle = this.#handles.get(id);
    if (!handle) throw new Error('Process session "' + id + '" has no live handle.');

    await this.#driver.write(handle, input, appendNewline);
    this.#sessions.touch(id);
    return this.viewWithContext(context, id);
  }

  output(
    id: string,
    cursor = 0,
    maxChars = MAX_OUTPUT_CHARS
  ): ProcessOutputView {
    return this.outputWithContext(this.#interactiveContext(), id, cursor, maxChars);
  }

  outputWithContext(
    context: ExecutionContext,
    id: string,
    cursor = 0,
    maxChars = MAX_OUTPUT_CHARS
  ): ProcessOutputView {
    const record = this.#assertAccess(id, context);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    const page = this.#sessions.events(id, cursor, maxChars);
    const events: ProcessOutputEvent[] = page.events
      .filter((event) => event.channel === "stdout" || event.channel === "stderr")
      .map((event) => ({
        seq: event.seq,
        stream: event.channel as "stdout" | "stderr",
        text: event.text,
        timestamp: event.timestamp
      }));
    const code = exitCode(record);
    return {
      sessionId: id,
      workspaceId: record.context.workspaceId,
      state: processState(record),
      events,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      ...(code !== undefined ? { exitCode: code } : {})
    };
  }

  async wait(id: string, timeoutMs = 30_000): Promise<ProcessWaitView> {
    return this.waitWithContext(this.#interactiveContext(), id, timeoutMs);
  }

  async waitWithContext(
    context: ExecutionContext,
    id: string,
    timeoutMs = 30_000
  ): Promise<ProcessWaitView> {
    const deadline = Date.now() + timeoutMs;
    let record = this.#assertAccess(id, context);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    while (!isSessionTerminal(record.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = this.#assertAccess(id, context);
    }
    const code = exitCode(record);
    return {
      sessionId: id,
      state: processState(record),
      completed: isSessionTerminal(record.state),
      ...(code !== undefined ? { exitCode: code } : {})
    };
  }

  async stop(id: string, force = false): Promise<ProcessSessionView> {
    return this.stopWithContext(this.#interactiveContext(), id, force);
  }

  async stopWithContext(
    context: ExecutionContext,
    id: string,
    force = false
  ): Promise<ProcessSessionView> {
    const record = this.#assertAccess(id, context);
    attachExecutionCorrelation({
      sessionId: id,
      actorType: record.context.actor.type,
      actorId: record.context.actor.id,
      taskId: record.context.taskId
    });
    if (isSessionTerminal(record.state)) return this.#viewRecord(record);

    const handle = this.#handles.get(id);
    if (!handle) {
      this.#sessions.transition(id, "interrupted", { recoveryHint: "inspect" });
      return this.viewWithContext(context, id);
    }

    this.#sessions.transition(id, "stopping", {
      recoveryHint: "inspect",
      attributes: { stopRequested: true }
    });
    await this.#driver.stop(handle, force ? "force" : "graceful");

    const current = this.#sessions.get(id);
    if (!isSessionTerminal(current.state)) {
      this.#sessions.transition(id, "completed", {
        recoveryHint: "inspect",
        attributes: { completion: "stopped", exitCode: null, pid: null }
      });
    }
    this.#handles.delete(id);
    return this.viewWithContext(context, id);
  }

  async interruptAll(): Promise<void> {
    await this.#driver.closeAll();
    for (const [id] of this.#handles) {
      let record: SessionRecord;
      try { record = this.#sessions.get(id); } catch { continue; }
      if (!isSessionTerminal(record.state)) {
        this.#sessions.transition(id, "interrupted", { recoveryHint: "inspect" });
      }
    }
    this.#handles.clear();
  }
}
