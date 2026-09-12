import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { encodeFolderPath } from "../client/folder-encoding.js";

vi.mock("@blackbelt-technology/dashboard-plugin-runtime/context", () => ({
  usePluginConfig: () => ({ pollIntervalMs: 60_000 }),
}));

vi.mock("../client/api.js", () => ({
  fetchOverview: vi.fn(async () => ({
    projectId: "project-1", repoRoot: "/repo", branch: "main", head: "abc", dirty: false,
    primary: { sessionId: "primary", sessionFile: "/sessions/primary.jsonl", status: "streaming", costUsd: 1 },
    workers: [{
      taskId: "task-1", projectId: "project-1", prompt: "Implement review flow",
      sessionId: "child-1", branch: "hermes/review", state: "awaiting_review",
      sessionStatus: "idle", costUsd: 0.5, updatedAt: new Date(0).toISOString(),
    }],
    attentionCount: 1, projectCostUsd: 1.5,
  })),
  control: vi.fn(),
  fetchChildReview: vi.fn(),
  integrateChild: vi.fn(),
}));

import { OrchestratorPanel } from "../client/OrchestratorPanel.js";

describe("OrchestratorPanel", () => {
  it("shows primary, parallel lifecycle, attention, and aggregate cost", async () => {
    render(<OrchestratorPanel params={{ encodedCwd: encodeFolderPath("/repo") }} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText("Implement review flow")).toBeTruthy());
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText("awaiting_review")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    expect(screen.getByText("⚠ 1")).toBeTruthy();
  });
});
