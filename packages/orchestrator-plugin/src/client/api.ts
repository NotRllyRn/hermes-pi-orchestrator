import type { ChildReview, OrchestratorOverview } from "../shared/types.js";

async function request<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export function fetchOverview(cwd: string): Promise<OrchestratorOverview> {
  return request(`/api/hermes-orchestrator/overview?path=${encodeURIComponent(cwd)}`);
}

export function control(
  cwd: string,
  body: { action: "queue" | "steer" | "abort"; sessionId?: string; taskId?: string; message?: string },
): Promise<unknown> {
  return request("/api/hermes-orchestrator/control", { path: cwd, ...body });
}

export async function fetchChildReview(taskId: string): Promise<ChildReview> {
  const result = await request<{ data: ChildReview }>(
    `/api/hermes-orchestrator/child/${encodeURIComponent(taskId)}/review`,
  );
  return result.data;
}
