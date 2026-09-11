import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type {
  OrchestratorSession,
  OrchestratorState,
  OrchestratorTask,
} from "../shared/types.js";

export interface OrchestratorClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
}

export function createOrchestratorClient(
  baseUrl = process.env.HERMES_ORCHESTRATOR_URL ?? "http://127.0.0.1:8787",
  token = process.env.HERMES_ORCHESTRATOR_TOKEN ?? "",
): OrchestratorClient {
  const root = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Orchestrator returned ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body: Record<string, unknown>) => request<T>(path, body),
  };
}

export async function registerPlugin(ctx: ServerPluginContext): Promise<void> {
  const client = createOrchestratorClient();

  ctx.fastify.get("/api/pi-orchestrator/state", async (): Promise<OrchestratorState> => {
    try {
      const [sessions, queue] = await Promise.all([
        client.get<OrchestratorSession[]>("/sessions"),
        client.get<OrchestratorTask[]>("/queue"),
      ]);
      return { connected: true, sessions, queue };
    } catch (error) {
      return {
        connected: false,
        sessions: [],
        queue: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const sessionActions = ["start", "send", "stop"] as const;
  for (const action of sessionActions) {
    ctx.fastify.post<{ Body: Record<string, unknown> }>(
      `/api/pi-orchestrator/sessions/${action}`,
      async (request) => client.post(`/sessions/${action}`, request.body),
    );
  }

  ctx.fastify.post<{ Body: Record<string, unknown> }>(
    "/api/pi-orchestrator/queue",
    async (request) => client.post("/queue", request.body),
  );
  ctx.fastify.post<{ Body: Record<string, unknown> }>(
    "/api/pi-orchestrator/queue/cancel",
    async (request) => client.post("/queue/cancel", request.body),
  );

  ctx.logger.info("Hermes Pi Orchestrator routes registered");
}

export default registerPlugin;
