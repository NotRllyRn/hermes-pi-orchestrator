import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import activateServer, {
  boundedJson,
  canonicalRepository,
  createParallelWorker,
  redact,
  register,
} from "../server/index.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("Server C safety helpers", () => {
  it("exports the Dashboard server activator as default", () => {
    expect(activateServer).toBe(register);
  });

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
        primarySessionFile: "/sessions/primary.jsonl", primarySessionId: "primary", prompt: "Build feature",
      }
    );

    expect(result.sessionId).toBe("child");
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("child:[PARALLEL TASK CONTEXT]");
    expect(sent[0]).toContain("Task: Build feature");
  });

  it("rejects a primary session from a different project", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-project-bind-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    for (const repo of [first, second]) {
      mkdirSync(repo);
      git(repo, "init");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      git(repo, "commit", "--allow-empty", "-m", "init");
    }
    const ctx = {
      sessionManager: { listAll: () => [{ id: "primary", cwd: first, sessionFile: "/primary.jsonl" }] },
    } as unknown as Parameters<typeof createParallelWorker>[0];

    await expect(createParallelWorker(ctx, { allowedRoots: [root] }, {
      projectId: "project-2", taskId: "cross-project", repoRoot: second,
      primarySessionFile: "/primary.jsonl", primarySessionId: "primary", prompt: "wrong repo",
    })).rejects.toThrow("different project");
  });

  it("rejects dirty trees even when a direct caller requests committed HEAD", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-dirty-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "commit", "--allow-empty", "-m", "init");
    writeFileSync(path.join(repo, "untracked.txt"), "dirty\n");
    const ctx = {
      sessionManager: { listAll: () => [{ id: "primary", cwd: repo, sessionFile: "/primary.jsonl" }] },
    } as unknown as Parameters<typeof createParallelWorker>[0];
    const request = {
      projectId: "project-1", taskId: "dirty-head", repoRoot: repo,
      primarySessionFile: "/primary.jsonl", primarySessionId: "primary", prompt: "dirty",
      dirtyPolicy: "head",
    } as unknown as Parameters<typeof createParallelWorker>[2];

    await expect(createParallelWorker(ctx, { allowedRoots: [root] }, request)).rejects.toThrow(
      "use Hermes to authorize committed HEAD",
    );
  });

  it("issues a canonical one-time dirty authorization before spawning", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-authorize-"));
    const repo = path.join(root, "repo");
    const alias = path.join(root, "alias");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "commit", "--allow-empty", "-m", "init");
    writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
    symlinkSync(repo, alias);
    const app = Fastify();
    vi.stubEnv("PI_ORCHESTRATOR_AUTH_SECRET", "test-secret");
    const sessions = [{ id: "primary", cwd: repo, sessionFile: "/primary.jsonl", status: "idle" }];
    const ctx = {
      fastify: app,
      getPluginConfig: () => ({ allowedRoots: [root], journalPath: path.join(root, "journal.json") }),
      sessionManager: { listAll: () => sessions },
      spawnSession: async (options: { cwd: string }) => {
        sessions.push({ id: "child", cwd: options.cwd, sessionFile: "/child.jsonl", status: "idle" });
        return { success: true, spawnToken: "spawn-token" };
      },
      sendToSession: vi.fn(() => true),
      abortSpawnedRun: vi.fn(async () => true),
      logger: { error: vi.fn() },
      eventStore: { getEvents: () => [] },
      emitEventToSession: vi.fn(() => true),
    } as unknown as Parameters<typeof register>[0];
    register(ctx);
    const body = {
      projectId: "project-1", taskId: "authorized-task", repoRoot: alias,
      primarySessionFile: "/primary.jsonl", primarySessionId: "primary", prompt: "authorized work",
    };

    const unauthenticated = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel/authorize", payload: body,
    });
    expect(unauthenticated.statusCode).toBe(403);
    const unauthenticatedSpawn = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel", payload: body,
    });
    expect(unauthenticatedSpawn.statusCode).toBe(403);
    const authorization = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel/authorize", payload: body,
      headers: { "x-hermes-orchestrator-authorization": "test-secret" },
    });
    expect(authorization.statusCode).toBe(200);
    const token = authorization.json().authorizationToken as string;
    expect(token).toBeTruthy();

    const headers = { "x-hermes-orchestrator-authorization": "test-secret" };
    const denied = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel",
      headers, payload: { ...body, authorizationToken: "wrong" },
    });
    expect(denied.statusCode).toBe(409);
    const changed = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel",
      headers, payload: { ...body, prompt: "different work", authorizationToken: token },
    });
    expect(changed.statusCode).toBe(409);

    const started = await app.inject({
      method: "POST", url: "/api/hermes-orchestrator/parallel",
      headers, payload: { ...body, authorizationToken: token },
    });
    expect(started.statusCode).toBe(200);
    const transaction = await app.inject({
      method: "GET", url: "/api/hermes-orchestrator/transaction/authorized-task",
    });
    expect(transaction.json().repoRoot).toBe(repo);
    expect(transaction.json()).not.toHaveProperty("authorizationTokenHash");
    expect(transaction.json()).not.toHaveProperty("spawnToken");
    const deniedIntegration = await app.inject({
      method: "POST",
      url: "/api/hermes-orchestrator/child/authorized-task/integrate",
      payload: { strategy: "merge" },
    });
    expect(deniedIntegration.statusCode).toBe(403);
    await app.close();
    vi.unstubAllEnvs();
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
      sessionManager: { listAll: () => [{ id: "primary", cwd: repo, sessionFile: "/sessions/primary.jsonl" }] },
      spawnSession: async () => ({ success: false, message: "no spawn" }),
      abortSpawnedRun: async () => true,
    } as unknown as Parameters<typeof createParallelWorker>[0];

    await expect(createParallelWorker(
      ctx,
      { allowedRoots: [root] },
      {
        projectId: "project-1", taskId: "87654321-rest", repoRoot: repo,
        primarySessionFile: "/sessions/primary.jsonl", primarySessionId: "primary", prompt: "Fail spawn",
      }
    )).rejects.toThrow("no spawn");

    expect(existsSync(path.join(root, ".hermes-worktrees", "fail-spawn-87654321"))).toBe(false);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", "hermes/fail-spawn-87654321"], {
      encoding: "utf8",
    }).trim()).toBe("");
  });
});
