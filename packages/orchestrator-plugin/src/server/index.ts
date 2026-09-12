import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { execFileSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { childReview, type IntegrationStrategy, integrateChild } from "./lifecycle.js";
import { buildOverview, sendPrimaryPrompt } from "./overview.js";
import { TransactionJournal, type TransactionRecord, type TransactionState } from "./transactions.js";

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
  primarySessionId: string;
  prompt: string;
  baseBranch?: string;
  baseCommit?: string;
  authorizationToken?: string;
}

interface ControlRequest {
  path?: string;
  action?: "queue" | "steer" | "abort";
  sessionId?: string;
  taskId?: string;
  message?: string;
}

interface ParallelResult {
  sessionId: string;
  sessionFile?: string;
  branch: string;
  worktreePath: string;
  spawnToken: string;
  baseCommit: string;
  baseBranch: string;
  repoRoot: string;
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

function validatedProjectRoot(
  ctx: ServerPluginContext,
  config: PluginConfig,
  request: ParallelRequest,
): string {
  const source = (ctx.sessionManager.listAll() as SessionView[]).find(
    (session) => session.sessionFile === request.primarySessionFile &&
      (session.id === request.primarySessionId || session.sessionId === request.primarySessionId),
  );
  if (!source) throw new Error("primary Pi session file is not known to Dashboard");
  if (!source.cwd) throw new Error("primary Pi session has no project path");
  const roots = config.allowedRoots ?? [];
  if (roots.length === 0) throw new Error("plugin allowedRoots is not configured");
  const repoRoot = canonicalRepository(request.repoRoot, roots);
  if (canonicalRepository(source.cwd, roots) !== repoRoot) {
    throw new Error("primary Pi session belongs to a different project");
  }
  return repoRoot;
}

function projectIsDirty(repoRoot: string): boolean {
  return Boolean(execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim());
}

function currentBranch(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function branchCommit(repoRoot: string, branch: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", branch], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

export async function createParallelWorker(
  ctx: ServerPluginContext,
  config: PluginConfig,
  request: ParallelRequest,
  progress: (state: TransactionState, details: Partial<ParallelResult>) => void = () => {},
  allowDirty = false,
): Promise<ParallelResult> {
  const repoRoot = validatedProjectRoot(ctx, config, request);
  const prepared = prepareParallelWorktree(config, request, repoRoot, allowDirty);
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
  repoRoot: string,
  allowDirty: boolean,
): Pick<ParallelResult, "branch" | "worktreePath" | "baseCommit" | "baseBranch" | "repoRoot"> {
  const roots = config.allowedRoots ?? [];
  const root = realpathSync(roots[0]);
  const requestedRoot = path.resolve(config.worktreeRoot ?? path.join(root, ".hermes-worktrees"));
  if (!inside(root, requestedRoot)) throw new Error("worktreeRoot is outside configured allowedRoots");
  mkdirSync(requestedRoot, { recursive: true });
  const worktreeRoot = realpathSync(requestedRoot);
  if (!inside(root, worktreeRoot)) throw new Error("canonical worktreeRoot escapes configured allowedRoots");
  const baseBranch = request.baseBranch ?? execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (!baseBranch) throw new Error("parallel creation requires a named primary branch");
  const baseCommit = request.baseCommit ?? branchCommit(repoRoot, baseBranch);
  if (projectIsDirty(repoRoot) && !allowDirty) {
    throw new Error("primary working tree is dirty; use Hermes to authorize committed HEAD in a later turn");
  }
  const suffix = request.taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "task";
  const slug = request.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "work";
  const branch = `hermes/${slug}-${suffix}`;
  const worktreePath = path.join(worktreeRoot, `${slug}-${suffix}`);
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, baseCommit], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (config.initCommand) {
      execFileSync("sh", ["-lc", config.initCommand], { cwd: worktreePath, encoding: "utf8", timeout: 120_000 });
    }
    return { repoRoot, branch, worktreePath, baseCommit, baseBranch };
  } catch (error) {
    tryGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    tryGit(repoRoot, ["branch", "-D", branch]);
    throw error;
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validAuthorization(transaction: TransactionRecord | undefined, token: string | undefined): boolean {
  if (!transaction || !token || !transaction.authorizationTokenHash || !transaction.authorizationExpiresAt) return false;
  if (Date.parse(transaction.authorizationExpiresAt) <= Date.now()) return false;
  return safeEqual(transaction.authorizationTokenHash, tokenHash(token).toString("hex"));
}

function hermesAuthorized(header: string | string[] | undefined): boolean {
  const expected = process.env.PI_ORCHESTRATOR_AUTH_SECRET;
  const provided = Array.isArray(header) ? header[0] : header;
  return Boolean(expected && provided && safeEqual(expected, provided));
}

function publicOperation(value: ParallelResult | TransactionRecord): Record<string, unknown> {
  const {
    authorizationTokenHash: _authorizationTokenHash,
    spawnToken: _spawnToken,
    ...publicValue
  } = value as TransactionRecord;
  return publicValue;
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

async function controlProject(
  ctx: ServerPluginContext,
  journal: TransactionJournal,
  config: PluginConfig,
  body: ControlRequest,
): Promise<Record<string, unknown>> {
  const repoRoot = canonicalRepository(body.path ?? "", config.allowedRoots ?? []);
  if (body.action === "abort") {
    const transaction = body.taskId ? journal.get(body.taskId) : undefined;
    if (!transaction || transaction.repoRoot !== repoRoot || !transaction.sessionId) {
      throw new Error("parallel child not found");
    }
    const aborted = await ctx.abortSpawnedRun({
      sessionId: transaction.sessionId, spawnToken: transaction.spawnToken, graceful: false,
    });
    if (!aborted) throw new Error("child is not running");
    return { accepted: true };
  }
  if (!body.sessionId || !body.message?.trim()) {
    throw new Error("sessionId and message are required");
  }
  const primary = (ctx.sessionManager.listAll() as SessionView[]).find(
    (session) => (session.id === body.sessionId || session.sessionId === body.sessionId) &&
      session.cwd && realpathOrOriginal(session.cwd) === repoRoot,
  );
  if (!primary) throw new Error("primary session not found in project");
  const delivery = body.action === "steer" ? "steer" : "followUp";
  sendPrimaryPrompt(ctx, body.sessionId, body.message.trim(), delivery);
  return { accepted: true, delivery };
}

function validParallelRequest(body: ParallelRequest | undefined): body is ParallelRequest {
  return Boolean(
    body?.projectId && body.taskId && body.repoRoot && body.primarySessionFile &&
    body.primarySessionId && body.prompt,
  );
}

function issueParallelAuthorization(
  ctx: ServerPluginContext,
  config: PluginConfig,
  journal: TransactionJournal,
  body: ParallelRequest,
): { authorizationToken: string; authorizationExpiresAt: string } {
  const repoRoot = validatedProjectRoot(ctx, config, body);
  if (!projectIsDirty(repoRoot)) throw new Error("primary working tree is clean");
  if (journal.get(body.taskId)) throw new Error("parallel authorization already exists for this task");
  const authorizationToken = randomBytes(32).toString("base64url");
  const authorizationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const baseBranch = body.baseBranch ?? currentBranch(repoRoot);
  if (!baseBranch) throw new Error("parallel authorization requires a named primary branch");
  const baseCommit = branchCommit(repoRoot, baseBranch);
  journal.put({
    taskId: body.taskId,
    projectId: body.projectId,
    repoRoot,
    prompt: body.prompt,
    primarySessionId: body.primarySessionId,
    primarySessionFile: body.primarySessionFile,
    baseBranch,
    baseCommit,
    state: "authorization_pending",
    authorizationTokenHash: tokenHash(authorizationToken).toString("hex"),
    authorizationExpiresAt,
  });
  return { authorizationToken, authorizationExpiresAt };
}

function beginParallelTransaction(
  ctx: ServerPluginContext,
  config: PluginConfig,
  journal: TransactionJournal,
  activeProjects: Set<string>,
  body: ParallelRequest,
): { repoRoot: string; dirty: boolean; baseBranch: string; baseCommit: string; replay?: TransactionRecord } {
  const repoRoot = validatedProjectRoot(ctx, config, body);
  const dirty = projectIsDirty(repoRoot);
  const baseBranch = body.baseBranch ?? currentBranch(repoRoot);
  if (!baseBranch) throw new Error("parallel creation requires a named primary branch");
  const baseCommit = branchCommit(repoRoot, baseBranch);
  const existing = journal.get(body.taskId);
  if (existing?.state === "complete") return { repoRoot, dirty, baseBranch, baseCommit, replay: existing };
  if (existing?.state === "authorization_pending" && (
    !validAuthorization(existing, body.authorizationToken) ||
    existing.repoRoot !== repoRoot || existing.projectId !== body.projectId ||
    existing.primarySessionId !== body.primarySessionId ||
    existing.primarySessionFile !== body.primarySessionFile ||
    existing.prompt !== body.prompt || existing.baseBranch !== baseBranch ||
    existing.baseCommit !== baseCommit
  )) {
    throw new Error("parallel authorization does not match the authorized request");
  }
  if (dirty && existing?.state !== "authorization_pending") {
    throw new Error("dirty parallel start requires a valid one-time authorization");
  }
  if (existing && existing.state !== "authorization_pending") {
    throw new Error("parallel transaction already exists and will not be replayed automatically");
  }
  if (activeProjects.has(repoRoot)) throw new Error("parallel creation is already active for this project");
  activeProjects.add(repoRoot);
  const transaction = {
    taskId: body.taskId,
    projectId: body.projectId,
    repoRoot,
    prompt: body.prompt,
    primarySessionId: body.primarySessionId,
    primarySessionFile: body.primarySessionFile,
    baseBranch,
    baseCommit,
    state: "preparing" as const,
    authorizationTokenHash: undefined,
    authorizationExpiresAt: undefined,
  };
  if (existing) journal.update(body.taskId, transaction);
  else journal.put(transaction);
  return { repoRoot, dirty, baseBranch, baseCommit };
}

async function spawnParallelTransaction(
  ctx: ServerPluginContext,
  config: PluginConfig,
  journal: TransactionJournal,
  body: ParallelRequest,
  repoRoot: string,
  allowDirty: boolean,
): Promise<ParallelResult> {
  try {
    const result = await createParallelWorker(ctx, config, { ...body, repoRoot }, (state, details) => {
      journal.update(body.taskId, { state, ...details });
    }, allowDirty);
    journal.update(body.taskId, { state: "complete", ...result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.update(body.taskId, { state: "failed", error: message });
    ctx.logger.error("Parallel worker transaction rolled back", error);
    throw error;
  }
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

  ctx.fastify.get<{ Querystring: { path?: string } }>(
    "/api/hermes-orchestrator/overview",
    async (request, reply) => {
      try {
        if (!request.query.path) return reply.code(400).send({ error: "path is required" });
        const repoRoot = canonicalRepository(request.query.path, configuredRoots);
        const branch = execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
          encoding: "utf8", timeout: 10_000,
        }).trim();
        const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
          encoding: "utf8", timeout: 10_000,
        }).trim();
        const dirty = Boolean(execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
          encoding: "utf8", timeout: 10_000,
        }).trim());
        return buildOverview(ctx, journal, repoRoot, { branch, head, dirty });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  ctx.fastify.post<{ Body: ControlRequest }>(
    "/api/hermes-orchestrator/control",
    async (request, reply) => {
      if (!request.body?.path || !request.body.action) {
        return reply.code(400).send({ error: "path and action are required" });
      }
      try {
        return await controlProject(ctx, journal, config, request.body);
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  ctx.fastify.post<{ Body: ParallelRequest }>(
    "/api/hermes-orchestrator/parallel/authorize",
    async (request, reply) => {
      if (!hermesAuthorized(request.headers["x-hermes-orchestrator-authorization"])) {
        return reply.code(403).send({ error: "Hermes authorization is required" });
      }
      const body = request.body;
      if (!validParallelRequest(body)) return reply.code(400).send({ error: "parallel request fields are required" });
      try {
        return issueParallelAuthorization(ctx, config, journal, body);
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  const activeProjects = new Set<string>();
  ctx.fastify.post<{ Body: ParallelRequest }>(
    "/api/hermes-orchestrator/parallel",
    async (request, reply) => {
      if (!hermesAuthorized(request.headers["x-hermes-orchestrator-authorization"])) {
        return reply.code(403).send({ error: "Hermes authorization is required" });
      }
      const body = request.body;
      if (!validParallelRequest(body)) return reply.code(400).send({ error: "parallel request fields are required" });
      let started: ReturnType<typeof beginParallelTransaction>;
      try {
        started = beginParallelTransaction(ctx, config, journal, activeProjects, body);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (started.replay) return publicOperation(started.replay);
      try {
        const result = await spawnParallelTransaction(
          ctx, config, journal,
          { ...body, baseBranch: started.baseBranch, baseCommit: started.baseCommit },
          started.repoRoot, started.dirty,
        );
        return publicOperation(result);
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      } finally {
        activeProjects.delete(started.repoRoot);
      }
    },
  );

  ctx.fastify.get<{ Params: { taskId: string } }>(
    "/api/hermes-orchestrator/child/:taskId/review",
    async (request, reply) => {
      try {
        return boundedJson(childReview(ctx, journal, request.params.taskId), 256 * 1024);
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  ctx.fastify.post<{
    Params: { taskId: string };
    Body: { strategy?: IntegrationStrategy };
  }>("/api/hermes-orchestrator/child/:taskId/integrate", async (request, reply) => {
    if (!hermesAuthorized(request.headers["x-hermes-orchestrator-authorization"])) {
      return reply.code(403).send({ error: "Hermes authorization is required" });
    }
    const strategy = request.body?.strategy;
    if (!strategy || !["merge", "cherry_pick", "leave_branch"].includes(strategy)) {
      return reply.code(400).send({ error: "strategy must be merge, cherry_pick, or leave_branch" });
    }
    try {
      return integrateChild(ctx, journal, request.params.taskId, strategy);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  ctx.fastify.get<{ Params: { taskId: string } }>(
    "/api/hermes-orchestrator/transaction/:taskId",
    async (request, reply) => {
      const transaction = journal.get(request.params.taskId);
      if (!transaction) return reply.code(404).send({ error: "not found" });
      return publicOperation(transaction);
    },
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
