export const PROCESS_STATES = [
  "starting",
  "running",
  "exited",
  "stopped",
  "failed",
  "interrupted"
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];
export type ProcessMode = "command" | "terminal";
export type ProcessStream = "stdout" | "stderr";

export type ProcessOutputEvent = {
  seq: number;
  stream: ProcessStream;
  text: string;
  timestamp: string;
};

export type ProcessSessionRecord = {
  id: string;
  workspaceId: string;
  mode: ProcessMode;
  state: ProcessState;
  pid?: number;
  startedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  recoveryHint: "none" | "inspect" | "retry";
};

export type ProcessSessionView = ProcessSessionRecord & {
  bufferedEvents: number;
};

export type ProcessOutputView = {
  sessionId: string;
  workspaceId: string;
  state: ProcessState;
  events: ProcessOutputEvent[];
  nextCursor: number;
  truncated: boolean;
  exitCode?: number | null;
};

export type ProcessWaitView = {
  sessionId: string;
  state: ProcessState;
  completed: boolean;
  exitCode?: number | null;
};
