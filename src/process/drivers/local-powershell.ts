import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ProcessDriver,
  ProcessDriverHandle,
  ProcessDriverSink,
  ProcessDriverStartRequest
} from "../driver.js";

const execFileAsync = promisify(execFile);

type LiveHandle = {
  publicHandle: ProcessDriverHandle;
  child: ChildProcessWithoutNullStreams;
  sink: ProcessDriverSink;
};

function powershellExe(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

export class LocalPowerShellDriver implements ProcessDriver {
  readonly id = "local-powershell";
  readonly #live = new Map<string, LiveHandle>();

  async start(
    request: ProcessDriverStartRequest,
    sink: ProcessDriverSink
  ): Promise<ProcessDriverHandle> {
    if (request.mode === "command" && !request.command?.trim()) {
      throw new Error("Command mode requires a non-blank command.");
    }

    const args = request.mode === "command"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command!]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-NoExit", "-Command", "-"];

    const child = spawn(powershellExe(), args, {
      cwd: request.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const publicHandle: ProcessDriverHandle = {
      id: "handle-" + randomUUID()
    };

    const live: LiveHandle = { publicHandle, child, sink };
    this.#live.set(publicHandle.id, live);

    child.stdout.on("data", (chunk: Buffer | string) => sink.stdout(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => sink.stderr(String(chunk)));

    child.once("error", (error) => {
      sink.error(error);
      this.#live.delete(publicHandle.id);
    });

    child.once("exit", (code) => {
      sink.exit(code);
      this.#live.delete(publicHandle.id);
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        publicHandle.pid = child.pid;
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      if (child.pid) {
        publicHandle.pid = child.pid;
        resolve();
        return;
      }

      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    if (request.mode === "terminal" && request.command?.trim()) {
      child.stdin.write(request.command.trimEnd() + "\r\n");
    }

    return { ...publicHandle };
  }

  async write(
    handle: ProcessDriverHandle,
    input: string,
    appendNewline: boolean
  ): Promise<void> {
    const live = this.#live.get(handle.id);
    if (!live) throw new Error('Process handle "' + handle.id + '" is not live.');
    if (live.child.stdin.destroyed) {
      throw new Error('Process handle "' + handle.id + '" stdin is unavailable.');
    }

    await new Promise<void>((resolve, reject) => {
      live.child.stdin.write(
        input + (appendNewline ? "\r\n" : ""),
        (error) => error ? reject(error) : resolve()
      );
    });
  }

  async stop(
    handle: ProcessDriverHandle,
    mode: "graceful" | "force"
  ): Promise<void> {
    const live = this.#live.get(handle.id);
    if (!live) return;

    if (process.platform === "win32" && live.child.pid) {
      const args = [
        "/PID",
        String(live.child.pid),
        "/T",
        ...(mode === "force" ? ["/F"] : [])
      ];

      try {
        await execFileAsync("taskkill.exe", args, {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 128 * 1024
        });
      } catch {
        if (mode === "force") {
          throw new Error('Failed to force-stop process handle "' + handle.id + '".');
        }
        live.child.kill();
      }
      return;
    }

    live.child.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
  }

  async closeAll(): Promise<void> {
    const handles = [...this.#live.values()].map((entry) => ({
      ...entry.publicHandle
    }));

    for (const handle of handles) {
      try {
        await this.stop(handle, "force");
      } catch {
        // Best effort during shutdown.
      }
    }
  }
}
