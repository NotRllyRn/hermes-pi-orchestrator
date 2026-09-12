export interface PrimaryWorker {
  sessionId: string;
  sessionFile?: string;
  status: string;
  model?: string;
  costUsd: number;
}

export interface ParallelWorker {
  taskId: string;
  projectId: string;
  prompt?: string;
  sessionId?: string;
  sessionFile?: string;
  branch?: string;
  worktreePath?: string;
  baseCommit?: string;
  state: string;
  sessionStatus: string;
  costUsd: number;
  error?: string;
  updatedAt: string;
}

export interface OrchestratorOverview {
  projectId: string;
  repoRoot: string;
  branch: string;
  head: string;
  dirty: boolean;
  primary: PrimaryWorker | null;
  workers: ParallelWorker[];
  attentionCount: number;
  projectCostUsd: number;
}

export interface ChildReview {
  taskId: string;
  state: string;
  sessionId: string;
  branch?: string;
  worktreePath: string;
  baseCommit: string;
  git: {
    status: string;
    commits: string[];
    diffStat: string;
    changedPaths: string[];
  };
  recentEvents: Array<Record<string, unknown>>;
  truncated?: boolean;
}
