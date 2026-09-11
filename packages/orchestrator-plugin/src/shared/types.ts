export type SessionStatus = "idle" | "busy" | "paused" | "error" | "stopped";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface OrchestratorSession {
  session_key: string;
  pi_session_file: string;
  cwd: string;
  model: string | null;
  thinking: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_active_at: string;
  last_result: string;
  error: string | null;
  process_running: boolean;
  pid: number | null;
  stderr: string;
}

export interface OrchestratorTask {
  task_id: string;
  prompt: string;
  working_dir: string;
  model: string | null;
  priority: number;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  result: string;
  error: string | null;
  session_key: string | null;
}

export interface OrchestratorState {
  connected: boolean;
  sessions: OrchestratorSession[];
  queue: OrchestratorTask[];
  error?: string;
}
