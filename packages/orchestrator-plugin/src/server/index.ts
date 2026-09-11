import { mkdirSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { execFileSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { TransactionJournal, type TransactionState } from "./transactions.js";

interface PluginConfig {
  allowedRoots?: string[];
  worktreeRoot?: string;
  initCommand?: string;
  journalPath?: string;
}

interface SessionView {
  id?: string;
  cwd?: string;
  sessionFile?: string;
  status?: string;
  startedAt?: number;
  model?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface ParallelRequest {
  projectId: string;
  taskId: string;
  repoRoot: string;
  primarySessionFile: string;
  prompt: string;
  baseBranch?: string;
  dirtyPolicy?: "reject" | "head";
}

interface ParallelResult {
  sessionId: string;
  sessionFile?: string;
  branch: string;
  worktreePath: string;
  spawnToken: string;
  baseCommit: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function canonicalRepository(repoPath: string, allowedRoots: string[]): string {
  if (!path.isAbsolute(repoPath)) throw new Error("repo path must be absolute");
  const canonical = realpathSync(repoPath);
  const roots = allowedRoots.map((root) => realpathSync(root));
  if (!roots.some((root) => inside(root, canonical))) {
    throw new Error("repository is outside configured allowedRoots");
  }
  const gitRoot = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const canonicalGitRoot = realpathSync(gitRoot);
  if (!roots.some((root) => inside(root, canonicalGitRoot))) {
    throw new Error("canonical Git root escapes configured allowedRoots");
  }
  return canonicalGitRoot;
}

const SECRET_KEY = /(?:token|secret|password|authorization|api[-_]?key|credential)/i;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function redact(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redact(item),
    ]),
  );
}

export function boundedJson(value: unknown, maxBytes = 32 * 1024): { data: JsonValue; truncated: boolean } {
  const safe = redact(value);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= maxBytes) return { data: safe, truncated: false };
  return {
    data: typeof safe === "string" ? safe.slice(0, maxBytes / 2) : [],
    truncated: true,
  };
}

export async function createParallelWorker(
  ctx: ServerPluginContext,
  config: PluginConfig,
  request: ParallelRequest,
  progress: (state: TransactionState, details: Partial<ParallelResult>) => void = () => {},
): Promise<ParallelResult> {
  const source = (ctx.sessionManager.listAll() as SessionView[]).find(
    (session) => session.sessionFile === request.primarySessionFile,
  );
  if (!source) throw new Error("primary Pi session file is not known to Dashboard");
  const prepared = prepareParallelWorktree(config, request);
  progress("worktree_created", prepared);
  let spawnToken: string | undefined;
  let sessionId: string | undefined;
  let committed = false;

  try {
    const spawned = await ctx.spawnSession({
      cwd: prepared.worktreePath,
      sessionFile: request.primarySessionFile,
      sessionMode: "fork",
      mode: "local",
      sandbox: "workspace-write",
    });
    if (!spawned.success || !spawned.spawnToken) throw new Error(spawned.message ?? "Dashboard rejected worker spawn");
    spawnToken = spawned.spawnToken;
    progress("spawned", { ...prepared, spawnToken });
    const session = await waitForSession(ctx, prepared.worktreePath);
    sessionId = session.id ?? session.sessionId;
    if (!sessionId) throw new Error("spawned Dashboard session has no id");
    progress("sending", { ...prepared, spawnToken, sessionId, sessionFile: session.sessionFile });
    const orientation = parallelOrientation(request, prepared);
    if (!ctx.sendToSession(sessionId, orientation)) throw new Error("failed to send task to spawned worker");
    committed = true;
    return { sessionId, sessionFile: session.sessionFile, ...prepared, spawnToken };
  } finally {
    if (!committed) await rollbackParallel(ctx, prepared, sessionId, spawnToken);
  }
}

function prepareParallelWorktree(
  config: PluginConfig,
  request: ParallelRequest,
): Pick<ParallelResult, "branch" | "worktreePath" | "baseCommit"> & { repoRoot: string } {
  const roots = config.allowedRoots ?? [];
  if (roots.length === 0) throw new Error("plugin allowedRoots is not configured");
  const repoRoot = canonicalRepository(request.repoRoot, roots);
  const root = realpathSync(roots[0]);
  const requestedRoot = path.resolve(config.worktreeRoot ?? path.join(root, ".hermes-worktrees"));
  if (!inside(root, requestedRoot)) throw new Error("worktreeRoot is outside configured allowedRoots");
  mkdirSync(requestedRoot, { recursive: true });
  const worktreeRoot = realpathSync(requestedRoot);
  if (!inside(root, worktreeRoot)) throw new Error("canonical worktreeRoot escapes configured allowedRoots");
  const baseCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", request.baseBranch ?? "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (dirty && request.dirtyPolicy !== "head") {
    throw new Error("primary working tree is dirty; choose wait or committed HEAD explicitly");
  }
  const suffix = request.taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "task";
  const slug = request.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "work";
  const branch = `hermes/${slug}-${suffix}`;
  const worktreePath = path.join(worktreeRoot, `${slug}-${suffix}`);
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, request.baseBranch ?? "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (config.initCommand) {
      execFileSync("sh", ["-lc", config.initCommand], { cwd: worktreePath, encoding: "utf8", timeout: 120_000 });
    }
    return { repoRoot, branch, worktreePath, baseCommit };
  } catch (error) {
    tryGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    tryGit(repoRoot, ["branch", "-D", branch]);
    throw error;
  }
}

async function rollbackParallel(
  ctx: ServerPluginContext,
  prepared: Pick<ParallelResult, "branch" | "worktreePath"> & { repoRoot: string },
  sessionId?: string,
  spawnToken?: string,
): Promise<void> {
  if (spawnToken || sessionId) await ctx.abortSpawnedRun({ sessionId, spawnToken, graceful: false });
  tryGit(prepared.repoRoot, ["worktree", "remove", "--force", prepared.worktreePath]);
  tryGit(prepared.repoRoot, ["branch", "-D", prepared.branch]);
}

async function waitForSession(ctx: ServerPluginContext, cwd: string): Promise<SessionView> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const session = (ctx.sessionManager.listAll() as SessionView[]).find(
      (item) => item.cwd && realpathOrOriginal(item.cwd) === cwd,
    );
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("spawned worker did not register within 20 seconds");
}

function tryGit(repoRoot: string, args: string[]): void {
  try {
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 30_000 });
  } catch {
    // Best-effort rollback; preserve the original transaction failure.
  }
}

function parallelOrientation(
  request: ParallelRequest,
  prepared: Pick<ParallelResult, "branch" | "worktreePath" | "baseCommit">,
): string {
  return [
    "[PARALLEL TASK CONTEXT]",
    `Task: ${request.prompt}`,
    `Worktree: ${prepared.worktreePath}`,
    `Branch: ${prepared.branch}`,
    `Base commit: ${prepared.baseCommit}`,
    "The primary session may change another worktree concurrently.",
    "Work only in this branch. Do not merge or modify the primary worktree.",
    "Leave a clean, reviewable result and report verification.",
  ].join("\n");
}

export function register(ctx: ServerPluginContext): void {
  const config = ctx.getPluginConfig<PluginConfig>();
  const configuredRoots = config.allowedRoots ?? [];
  const journal = new TransactionJournal(
    config.journalPath ?? path.join(homedir(), ".pi", "dashboard", "hermes-orchestrator-transactions.json"),
  );

  ctx.fastify.get<{ Querystring: { path?: string } }>(
    "/api/hermes-orchestrator/project",
    async (request, reply) => {
      try {
        if (!request.query.path) return reply.code(400).send({ error: "path is required" });
        if (configuredRoots.length === 0) {
          return reply.code(503).send({ error: "plugin allowedRoots is not configured" });
        }
        const repoRoot = canonicalRepository(request.query.path, configuredRoots);
        const sessions = (ctx.sessionManager.listAll() as SessionView[]).filter(
          (session) => session.cwd && realpathOrOriginal(session.cwd) === repoRoot,
        );
        const branch = execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
          encoding: "utf8",
          timeout: 10_000,
        }).trim();
        const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: 10_000,
        }).trim();
        const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
          encoding: "utf8",
          timeout: 10_000,
        }).trim().length > 0;
        return { serverId: hostname(), repoRoot, branch, head, dirty, sessions };
      } catch (error) {
        ctx.logger.warn("Project inspection rejected", error);
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  const activeProjects = new Set<string>();
  ctx.fastify.post<{ Body: ParallelRequest }>(
    "/api/hermes-orchestrator/parallel",
    async (request, reply) => {
      const body = request.body;
      if (!body?.projectId || !body.taskId || !body.repoRoot || !body.primarySessionFile || !body.prompt) {
        return reply.code(400).send({
          error: "projectId, taskId, repoRoot, primarySessionFile, and prompt are required",
        });
      }
      const existing = journal.get(body.taskId);
      if (existing?.state === "complete") return existing;
      if (existing) {
        return reply.code(409).send({
          error: "parallel transaction already exists and will not be replayed automatically",
          transaction: existing,
        });
      }
      if (activeProjects.has(body.projectId)) {
        return reply.code(409).send({ error: "parallel creation is already active for this project" });
      }
      activeProjects.add(body.projectId);
      journal.put({ taskId: body.taskId, projectId: body.projectId, repoRoot: body.repoRoot, state: "preparing" });
      try {
        const result = await createParallelWorker(ctx, config, body, (state, details) => {
          journal.update(body.taskId, { state, ...details });
        });
        journal.update(body.taskId, { state: "complete", ...result });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal.update(body.taskId, { state: "failed", error: message });
        ctx.logger.error("Parallel worker transaction rolled back", error);
        return reply.code(500).send({ error: message });
      } finally {
        activeProjects.delete(body.projectId);
      }
    },
  );

  ctx.fastify.get<{ Params: { taskId: string } }>(
    "/api/hermes-orchestrator/transaction/:taskId",
    async (request, reply) => journal.get(request.params.taskId) ?? reply.code(404).send({ error: "not found" }),
  );

  ctx.fastify.get<{
    Params: { sessionId: string };
    Querystring: { kind?: string; limit?: string | number };
  }>("/api/hermes-orchestrator/session/:sessionId/diagnostics", async (request, reply) => {
    const rawLimit = Number(request.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 200" });
    }
    if (request.query.kind !== "events") {
      return reply.code(400).send({ error: "supported diagnostic kind: events" });
    }
    const events = ctx.eventStore.getEvents(request.params.sessionId);
    if (!Array.isArray(events)) return reply.code(404).send({ error: "session events not found" });
    return boundedJson(events.slice(-rawLimit));
  });
}

function realpathOrOriginal(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}
