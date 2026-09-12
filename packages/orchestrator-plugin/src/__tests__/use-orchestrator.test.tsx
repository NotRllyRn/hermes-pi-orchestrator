import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/api.js", () => ({
  fetchOverview: vi.fn(),
  control: vi.fn(),
  fetchChildReview: vi.fn(),
  integrateChild: vi.fn(),
}));

import { control, fetchOverview } from "../client/api.js";
import { useOrchestrator } from "../client/useOrchestrator.js";
import type { OrchestratorOverview } from "../shared/types.js";

function overview(repoRoot: string): OrchestratorOverview {
  return {
    projectId: `project:${repoRoot}`, repoRoot, branch: "main", head: "abc", dirty: false,
    primary: { sessionId: "primary", sessionFile: "/session.jsonl", status: "idle", costUsd: 0 },
    workers: [], attentionCount: 0, projectCostUsd: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.clearAllMocks());

describe("useOrchestrator", () => {
  it("ignores an old folder response after navigation", async () => {
    const oldRequest = deferred<OrchestratorOverview>();
    const newRequest = deferred<OrchestratorOverview>();
    vi.mocked(fetchOverview).mockImplementation((cwd) =>
      cwd === "/old" ? oldRequest.promise : newRequest.promise
    );
    const { result, rerender } = renderHook(
      ({ cwd }) => useOrchestrator(cwd, 60_000),
      { initialProps: { cwd: "/old" } },
    );

    rerender({ cwd: "/new" });
    newRequest.resolve(overview("/new"));
    await waitFor(() => expect(result.current.overview?.repoRoot).toBe("/new"));
    oldRequest.resolve(overview("/old"));
    await act(async () => Promise.resolve());

    expect(result.current.overview?.repoRoot).toBe("/new");
  });

  it("preserves the draft when an action fails", async () => {
    vi.mocked(fetchOverview).mockResolvedValue(overview("/repo"));
    vi.mocked(control).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useOrchestrator("/repo", 60_000));
    await waitFor(() => expect(result.current.overview).not.toBeNull());

    act(() => result.current.setMessage("keep this"));
    act(() => result.current.submit("queue"));
    await waitFor(() => expect(result.current.error).toBe("offline"));

    expect(result.current.message).toBe("keep this");
  });
});
