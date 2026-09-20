export const SEARCH_STATES = [
  "running",
  "completed",
  "stopped",
  "failed",
  "interrupted"
] as const;

export type SearchState = (typeof SEARCH_STATES)[number];
export type SearchMode = "text" | "name";
export type SearchLimitReason = "max-results" | "timeout";

export type SearchResult = {
  index: number;
  path: string;
  line?: number;
  column?: number;
  preview?: string;
};

export type SearchSessionRecord = {
  id: string;
  workspaceId: string;
  mode: SearchMode;
  state: SearchState;
  startedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  resultCount: number;
  scannedFiles: number;
  limited: boolean;
  limitReason?: SearchLimitReason;
  error?: string;
};

export type SearchStatusView = SearchSessionRecord;

export type SearchPage = {
  searchId: string;
  workspaceId: string;
  state: SearchState;
  results: SearchResult[];
  nextCursor: number;
  done: boolean;
  totalAvailable: number;
  limited: boolean;
  limitReason?: SearchLimitReason;
};
