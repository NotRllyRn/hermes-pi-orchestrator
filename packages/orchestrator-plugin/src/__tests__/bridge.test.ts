import { describe, expect, it, vi } from "vitest";
import activate from "../bridge/index.js";

describe("integration history bridge", () => {
  it("appends durable metadata without sending an LLM message", () => {
    let handler: ((data: unknown) => void) | undefined;
    const appendEntry = vi.fn();
    activate({
      appendEntry,
      events: { on: (_name: string, registered: (data: unknown) => void) => { handler = registered; } },
    });

    handler?.({ taskId: "task-1" });

    expect(appendEntry).toHaveBeenCalledWith(
      "hermes-pi-orchestrator:integration", { taskId: "task-1" },
    );
  });
});
