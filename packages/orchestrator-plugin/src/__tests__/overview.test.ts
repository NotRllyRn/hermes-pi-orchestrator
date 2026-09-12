import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildOverview, sendPrimaryPrompt } from "../server/overview.js";
import { TransactionJournal } from "../server/transactions.js";

function journal(): TransactionJournal {
  return new TransactionJournal(path.join(mkdtempSync(path.join(tmpdir(), "overview-")), "journal.json"));
}

function context() {
  return {
    sessionManager: {
      listAll: () => [
        { id: "primary", cwd: "/repo", sessionFile: "/sessions/primary.jsonl", status: "streaming", cost: 1.25 },
        { id: "child", cwd: "/workers/child", status: "idle", cost: 0.5 },
      ],
    },
    emitEventToSession: vi.fn(() => true),
  } as unknown as Parameters<typeof buildOverview>[0];
}

describe("orchestrator overview", () => {
  it("projects primary and child lifecycle with aggregate cost", () => {
    const transactions = journal();
    transactions.put({
      taskId: "task-1", projectId: "project-1", state: "complete", repoRoot: "/repo",
      primarySessionId: "primary", sessionId: "child", branch: "hermes/child",
      worktreePath: "/workers/child", baseCommit: "abc", baseBranch: "main",
    });

    const result = buildOverview(context(), transactions, "/repo", {
      branch: "main", head: "abc", dirty: false,
    });

    expect(result.primary?.sessionId).toBe("primary");
    expect(result.workers[0]).toMatchObject({ taskId: "task-1", state: "ready_for_review" });
    expect(result.projectCostUsd).toBe(1.75);
    expect(result.attentionCount).toBe(1);
  });

  it("routes explicit queue and steer delivery to the selected primary", () => {
    const ctx = context();

    sendPrimaryPrompt(ctx, "primary", "next task", "followUp");
    sendPrimaryPrompt(ctx, "primary", "change direction", "steer");

    expect(ctx.emitEventToSession).toHaveBeenNthCalledWith(
      1, "primary", "hermes-orchestrator:prompt", { message: "next task", delivery: "followUp" },
    );
    expect(ctx.emitEventToSession).toHaveBeenNthCalledWith(
      2, "primary", "hermes-orchestrator:prompt", { message: "change direction", delivery: "steer" },
    );
  });
});
