import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TransactionState =
  | "authorization_pending"
  | "preparing"
  | "worktree_created"
  | "spawned"
  | "sending"
  | "complete"
  | "awaiting_review"
  | "integrating"
  | "integrated"
  | "retained"
  | "failed";

export interface TransactionRecord {
  taskId: string;
  projectId: string;
  state: TransactionState;
  updatedAt: string;
  repoRoot?: string;
  prompt?: string;
  baseBranch?: string;
  branch?: string;
  worktreePath?: string;
  baseCommit?: string;
  sessionId?: string;
  sessionFile?: string;
  spawnToken?: string;
  primarySessionId?: string;
  primarySessionFile?: string;
  integrationStrategy?: string;
  integratedCommit?: string;
  annotationRecorded?: boolean;
  integrationError?: string;
  authorizationTokenHash?: string;
  authorizationExpiresAt?: string;
  error?: string;
}

export class TransactionJournal {
  private records = new Map<string, TransactionRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(taskId: string): TransactionRecord | undefined {
    const record = this.records.get(taskId);
    return record ? { ...record } : undefined;
  }

  list(): TransactionRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  put(record: Omit<TransactionRecord, "updatedAt">): TransactionRecord {
    const saved = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(saved.taskId, saved);
    this.flush();
    return { ...saved };
  }

  update(taskId: string, changes: Partial<Omit<TransactionRecord, "taskId" | "projectId">>): TransactionRecord {
    const current = this.records.get(taskId);
    if (!current) throw new Error(`unknown parallel transaction: ${taskId}`);
    return this.put({ ...current, ...changes, taskId: current.taskId, projectId: current.projectId });
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error("parallel transaction journal is unreadable", { cause: error });
    }
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error("parallel transaction journal is invalid");
    }
    for (const item of parsed) this.records.set(item.taskId, item);
  }

  private flush(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

function isRecord(value: unknown): value is TransactionRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TransactionRecord>;
  return typeof item.taskId === "string" && typeof item.projectId === "string" &&
    typeof item.state === "string" && typeof item.updatedAt === "string";
}
