import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { execFileSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";

interface PluginConfig {
  allowedRoots?: string[];
}

interface SessionView {
  id?: string;
  cwd?: string;
  sessionFile?: string;
  status?: string;
  startedAt?: number;
  model?: string;
  [key: string]: unknown;
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

export function register(ctx: ServerPluginContext): void {
  const config = ctx.getPluginConfig<PluginConfig>();
  const configuredRoots = config.allowedRoots ?? [];

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
        return { serverId: hostname(), repoRoot, branch, head, sessions };
      } catch (error) {
        ctx.logger.warn("Project inspection rejected", error);
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
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
