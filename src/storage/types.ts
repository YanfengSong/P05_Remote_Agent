import type { IsolationStateRecord, RunEvent, RunFilter, RunRecord } from "../run/types.js";

export interface StateStore {
  createRun(run: RunRecord, event: RunEvent): void;
  updateRunAndAppendEvent(run: RunRecord, event: RunEvent): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(filter?: RunFilter): RunRecord[];
  listRunEvents(runId: string, afterSequence?: number, limit?: number): RunEvent[];

  upsertIsolation(record: IsolationStateRecord): void;
  getIsolation(id: string): IsolationStateRecord | undefined;
  listIsolations(workspaceId?: string): IsolationStateRecord[];

  close(): void;
}
