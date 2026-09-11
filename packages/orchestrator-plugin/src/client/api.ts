import type { OrchestratorState } from "../shared/types.js";

async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export function fetchState(): Promise<OrchestratorState> {
  return request("/api/pi-orchestrator/state");
}

export function sessionAction(
  action: "start" | "send" | "stop",
  body: Record<string, unknown>,
): Promise<unknown> {
  return request(`/api/pi-orchestrator/sessions/${action}`, body);
}

export function enqueueTask(body: Record<string, unknown>): Promise<unknown> {
  return request("/api/pi-orchestrator/queue", body);
}

export function cancelTask(taskId: string): Promise<unknown> {
  return request("/api/pi-orchestrator/queue/cancel", { task_id: taskId });
}
