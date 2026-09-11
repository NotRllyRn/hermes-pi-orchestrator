import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boundedJson, canonicalRepository, createParallelWorker, redact } from "../server/index.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("Server C safety helpers", () => {
  it("canonicalizes repositories inside an allowed root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-root-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init");
    expect(canonicalRepository(repo, [root])).toBe(repo);
  });

  it("rejects a symlink escape from an allowed root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "orchestrator-outside-"));
    git(outside, "init");
    const link = path.join(root, "escape");
    symlinkSync(outside, link);
    expect(() => canonicalRepository(link, [root])).toThrow("outside configured allowedRoots");
  });

  it("redacts nested secrets and bounds diagnostics", () => {
    expect(redact({ token: "abc", nested: { apiKey: "def", safe: "ok" } })).toEqual({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "ok" },
    });
    expect(boundedJson([{ text: "x".repeat(500) }], 32)).toEqual({ data: [], truncated: true });
  });

  it("creates and dispatches a parallel worker transaction", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-parallel-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "commit", "--allow-empty", "-m", "init");
    let cwd = "";
    const sent: string[] = [];
    const ctx = {
      sessionManager: {
        listAll: () => [
          { id: "primary", cwd: repo, sessionFile: "/sessions/primary.jsonl" },
          { id: "child", cwd, sessionFile: "/sessions/child.jsonl" },
        ],
      },
      spawnSession: async (options: { cwd: string }) => {
        cwd = options.cwd;
        return { success: true, spawnToken: "spawn-1" };
      },
      sendToSession: (id: string, prompt: string) => {
        sent.push(`${id}:${prompt}`);
        return true;
      },
      abortSpawnedRun: async () => true,
    } as unknown as Parameters<typeof createParallelWorker>[0];

    const result = await createParallelWorker(
      ctx,
      { allowedRoots: [root] },
      {
        projectId: "project-1", taskId: "12345678-rest", repoRoot: repo,
        primarySessionFile: "/sessions/primary.jsonl", prompt: "Build feature",
      }
    );

    expect(result.sessionId).toBe("child");
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("child:[PARALLEL TASK CONTEXT]");
    expect(sent[0]).toContain("Task: Build feature");
  });

  it("rolls back the worktree when Dashboard spawn fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-rollback-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "commit", "--allow-empty", "-m", "init");
    const ctx = {
      sessionManager: { listAll: () => [{ sessionFile: "/sessions/primary.jsonl" }] },
      spawnSession: async () => ({ success: false, message: "no spawn" }),
      abortSpawnedRun: async () => true,
    } as unknown as Parameters<typeof createParallelWorker>[0];

    await expect(createParallelWorker(
      ctx,
      { allowedRoots: [root] },
      {
        projectId: "project-1", taskId: "87654321-rest", repoRoot: repo,
        primarySessionFile: "/sessions/primary.jsonl", prompt: "Fail spawn",
      }
    )).rejects.toThrow("no spawn");

    expect(existsSync(path.join(root, ".hermes-worktrees", "fail-spawn-87654321"))).toBe(false);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", "hermes/fail-spawn-87654321"], {
      encoding: "utf8",
    }).trim()).toBe("");
  });
});
