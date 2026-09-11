import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { childReview, integrateChild } from "../server/lifecycle.js";
import { TransactionJournal } from "../server/transactions.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-lifecycle-"));
  const repo = path.join(root, "repo");
  const child = path.join(root, "child");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-b", "hermes/child", child, "main");
  appendFileSync(path.join(child, "file.txt"), "child\n");
  git(child, "add", "file.txt");
  git(child, "commit", "-m", "child change");
  const journal = new TransactionJournal(path.join(root, "journal.json"));
  journal.put({
    taskId: "task-1", projectId: "project-1", state: "complete", repoRoot: repo,
    baseBranch: "main", branch: "hermes/child", worktreePath: child, baseCommit: base,
    sessionId: "child-session", primarySessionId: "primary-session",
  });
  return { repo, journal };
}

describe("parallel child lifecycle", () => {
  it("builds a bounded-source review package", () => {
    const { journal } = fixture();
    const ctx = {
      eventStore: { getEvents: () => [{ eventType: "agent_settled" }] },
    } as unknown as Parameters<typeof childReview>[0];
    const review = childReview(ctx, journal, "task-1") as { git: { changedPaths: string[] } };
    expect(review.git.changedPaths).toEqual(["file.txt"]);
  });

  it("merges only into a clean base branch and records a Pi custom-entry event", () => {
    const { repo, journal } = fixture();
    const emitEventToSession = vi.fn(() => true);
    const ctx = { emitEventToSession } as unknown as Parameters<typeof integrateChild>[0];

    const result = integrateChild(ctx, journal, "task-1", "merge");

    expect(result.state).toBe("integrated");
    expect(git(repo, "log", "-1", "--format=%s")).toContain("Merge branch");
    expect(emitEventToSession).toHaveBeenCalledWith(
      "primary-session", "hermes-orchestrator:integration", expect.objectContaining({ taskId: "task-1" }),
    );
  });
});
