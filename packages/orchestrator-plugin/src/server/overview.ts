import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type { OrchestratorOverview } from "../shared/types.js";
import type { TransactionJournal, TransactionRecord } from "./transactions.js";

interface SessionView {
  id?: string;
  sessionId?: string;
  cwd?: string;
  sessionFile?: string;
  status?: string;
  model?: string;
  cost?: number;
}

export interface ProjectGitState {
  branch: string;
  head: string;
  dirty: boolean;
}

function sessionId(session: SessionView): string | undefined {
  return session.id ?? session.sessionId;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function workerState(transaction: TransactionRecord, session?: SessionView): string {
  if (transaction.state === "complete" && !session) return "disconnected";
  if (transaction.state === "complete" && (session?.status === "idle" || session?.status === "ended")) {
    return "ready_for_review";
  }
  if (transaction.state === "complete") return "active";
  return transaction.state;
}

export function buildOverview(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  repoRoot: string,
  git: ProjectGitState,
): OrchestratorOverview {
  const sessions = ctx.sessionManager.listAll() as SessionView[];
  const transactions = journal.list().filter((item) => item.repoRoot === repoRoot);
  const primaryId = transactions.find((item) => item.primarySessionId)?.primarySessionId ??
    sessionId(sessions.find((session) => session.cwd === repoRoot) ?? {});
  const primarySession = sessions.find((session) => sessionId(session) === primaryId);
  const workers = transactions.map((transaction) => {
    const session = sessions.find((item) => sessionId(item) === transaction.sessionId);
    return {
      taskId: transaction.taskId,
      projectId: transaction.projectId,
      prompt: transaction.prompt,
      sessionId: transaction.sessionId,
      sessionFile: transaction.sessionFile,
      branch: transaction.branch,
      worktreePath: transaction.worktreePath,
      baseCommit: transaction.baseCommit,
      state: workerState(transaction, session),
      sessionStatus: session?.status ?? "disconnected",
      costUsd: numeric(session?.cost),
      error: transaction.error ?? transaction.integrationError,
      updatedAt: transaction.updatedAt,
    };
  });
  const attentionCount = workers.filter((worker) =>
    ["ready_for_review", "awaiting_review", "disconnected", "failed", "integrating"].includes(worker.state)
  ).length;
  return {
    projectId: transactions[0]?.projectId ?? `project:${repoRoot}`,
    repoRoot,
    ...git,
    primary: primaryId ? {
      sessionId: primaryId,
      sessionFile: primarySession?.sessionFile,
      status: primarySession?.status ?? "disconnected",
      model: primarySession?.model,
      costUsd: numeric(primarySession?.cost),
    } : null,
    workers,
    attentionCount,
    projectCostUsd: numeric(primarySession?.cost) + workers.reduce(
      (total, worker) => total + worker.costUsd, 0,
    ),
  };
}

export function sendPrimaryPrompt(
  ctx: ServerPluginContext,
  sessionId: string,
  message: string,
  delivery: "steer" | "followUp",
): void {
  const session = (ctx.sessionManager.listAll() as SessionView[]).find(
    (item) => sessionId === (item.id ?? item.sessionId),
  );
  if (!session) throw new Error("primary session is not known to Dashboard");
  if (!ctx.emitEventToSession(sessionId, "hermes-orchestrator:prompt", { message, delivery })) {
    throw new Error("primary session is not connected");
  }
}
