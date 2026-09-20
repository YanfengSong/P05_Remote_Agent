import type { ProcessMode } from "./types.js";

export type ProcessDriverStartRequest = {
  mode: ProcessMode;
  command?: string;
  cwd: string;
};

export type ProcessDriverHandle = {
  id: string;
  pid?: number;
};

export type ProcessDriverSink = {
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number | null): void;
  error(error: Error): void;
};

export interface ProcessDriver {
  readonly id: string;

  start(
    request: ProcessDriverStartRequest,
    sink: ProcessDriverSink
  ): Promise<ProcessDriverHandle>;

  write(
    handle: ProcessDriverHandle,
    input: string,
    appendNewline: boolean
  ): Promise<void>;

  stop(
    handle: ProcessDriverHandle,
    mode: "graceful" | "force"
  ): Promise<void>;

  closeAll(): Promise<void>;
}
