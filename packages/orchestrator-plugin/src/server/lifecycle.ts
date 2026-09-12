import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { execFileSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import type { TransactionJournal, TransactionRecord } from "./transactions.js";

export type IntegrationStrategy = "merge" | "cherry_pick" | "leave_branch";

export function childReview(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  taskId: string,
): Record<string, unknown> {
  const transaction = markReviewable(ctx, journal, taskId);
  const worktree = required(transaction.worktreePath, "worktree path");
  const base = required(transaction.baseCommit, "base commit");
  const sessionId = required(transaction.sessionId, "session id");
  const status = git(worktree, ["status", "--porcelain"]);
  const commits = lines(git(worktree, ["log", "--format=%H%x09%s", `${base}..HEAD`]));
  const diffStat = git(worktree, ["diff", "--stat", `${base}...HEAD`]);
  const changedPaths = lines(git(worktree, ["diff", "--name-only", `${base}...HEAD`]));
  const events = ctx.eventStore.getEvents(sessionId);
  return {
    taskId,
    state: transaction.state,
    sessionId,
    branch: transaction.branch,
    worktreePath: worktree,
    baseCommit: base,
    git: {
      status: status.slice(0, 4_000),
      commits: commits.slice(-100).map((line) => line.slice(0, 500)),
      diffStat: diffStat.slice(0, 8_000),
      changedPaths: changedPaths.slice(0, 200).map((line) => line.slice(0, 500)),
    },
    recentEvents: events.slice(-20).map((event) => {
      const item = event as Record<string, unknown>;
      return { eventType: item.eventType, timestamp: item.timestamp };
    }),
    truncated: status.length > 4_000 || commits.length > 100 || diffStat.length > 8_000 ||
      changedPaths.length > 200,
  };
}

export function integrateChild(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  taskId: string,
  strategy: IntegrationStrategy,
): TransactionRecord {
  const transaction = lifecycleTransaction(journal, taskId);
  if (transaction.state !== "awaiting_review") {
    return existingOutcome(ctx, journal, transaction, strategy);
  }
  if (strategy === "leave_branch") {
    return journal.update(taskId, { state: "retained", integrationStrategy: strategy });
  }
  const repoRoot = required(transaction.repoRoot, "repository root");
  const branch = required(transaction.branch, "child branch");
  const baseBranch = required(transaction.baseBranch, "base branch");
  const worktree = required(transaction.worktreePath, "worktree path");
  if (git(worktree, ["status", "--porcelain"])) {
    throw new Error("child worktree is dirty; commit or discard child changes before integration");
  }
  if (git(repoRoot, ["status", "--porcelain"])) {
    throw new Error("primary working tree is dirty; integration refused");
  }
  if (git(repoRoot, ["branch", "--show-current"]) !== baseBranch) {
    throw new Error(`primary checkout must be on ${baseBranch}`);
  }
  journal.update(taskId, {
    state: "integrating", integrationStrategy: strategy, integrationError: undefined,
  });
  try {
    if (strategy === "merge") merge(repoRoot, branch);
    else cherryPick(repoRoot, required(transaction.baseCommit, "base commit"), branch);
  } catch (error) {
    journal.update(taskId, {
      state: "awaiting_review",
      integrationStrategy: undefined,
      integrationError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const integratedCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  const integrated = journal.update(taskId, {
    state: "integrated", integrationStrategy: strategy, integratedCommit, annotationRecorded: false,
  });
  return recordAnnotation(ctx, journal, integrated);
}

function existingOutcome(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  transaction: TransactionRecord,
  strategy: IntegrationStrategy,
): TransactionRecord {
  if (transaction.state === "complete") {
    throw new Error("parallel child must settle and enter review before integration");
  }
  if (transaction.integrationStrategy !== strategy) {
    throw new Error("parallel child already has a different integration outcome");
  }
  if (transaction.state === "integrated" && !transaction.annotationRecorded) {
    return recordAnnotation(ctx, journal, transaction);
  }
  return transaction;
}

function recordAnnotation(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  transaction: TransactionRecord,
): TransactionRecord {
  const primarySessionId = required(transaction.primarySessionId, "primary session id");
  const recorded = ctx.emitEventToSession(primarySessionId, "hermes-orchestrator:integration", {
    taskId: transaction.taskId,
    strategy: transaction.integrationStrategy,
    branch: transaction.branch,
    baseCommit: transaction.baseCommit,
    integratedCommit: transaction.integratedCommit,
  });
  const updated = journal.update(transaction.taskId, { annotationRecorded: recorded });
  if (!recorded) {
    throw new Error("code integrated, but primary history annotation is pending; retry the same strategy");
  }
  return updated;
}

function markReviewable(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  taskId: string,
): TransactionRecord {
  const transaction = lifecycleTransaction(journal, taskId);
  if (transaction.state === "awaiting_review") return transaction;
  if (transaction.state !== "complete") return transaction;
  const sessionId = required(transaction.sessionId, "session id");
  const session = (ctx.sessionManager.listAll() as Array<{ id?: string; sessionId?: string; status?: string }>).find(
    (item) => (item.id ?? item.sessionId) === sessionId,
  );
  if (!session || !["idle", "ended"].includes(session.status ?? "")) {
    throw new Error("parallel child is still active");
  }
  return journal.update(taskId, { state: "awaiting_review" });
}

function lifecycleTransaction(journal: TransactionJournal, taskId: string): TransactionRecord {
  const transaction = journal.get(taskId);
  if (!transaction || !["complete", "awaiting_review", "integrated", "retained"].includes(transaction.state)) {
    throw new Error("parallel child transaction is not ready for lifecycle actions");
  }
  return transaction;
}

function merge(repoRoot: string, branch: string): void {
  try {
    git(repoRoot, ["merge", "--no-ff", "--no-edit", branch]);
  } catch (error) {
    tryGit(repoRoot, ["merge", "--abort"]);
    throw error;
  }
}

function cherryPick(repoRoot: string, base: string, branch: string): void {
  const commits = lines(git(repoRoot, ["rev-list", "--reverse", `${base}..${branch}`]));
  if (commits.length === 0) throw new Error("child branch has no commits to cherry-pick");
  try {
    git(repoRoot, ["cherry-pick", ...commits]);
  } catch (error) {
    tryGit(repoRoot, ["cherry-pick", "--abort"]);
    throw error;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

function tryGit(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    // Preserve the integration error when best-effort conflict cleanup fails.
  }
}

function lines(value: string): string[] {
  return value ? value.split("\n") : [];
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`parallel transaction has no ${label}`);
  return value;
}
