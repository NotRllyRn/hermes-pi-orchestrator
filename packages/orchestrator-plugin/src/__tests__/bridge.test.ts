import { describe, expect, it, vi } from "vitest";
import activate from "../bridge/index.js";

describe("integration history bridge", () => {
  it("appends durable metadata without sending an LLM message", () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const appendEntry = vi.fn();
    activate({
      appendEntry,
      events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
    });

    handlers.get("hermes-orchestrator:integration")?.({ taskId: "task-1" });

    expect(appendEntry).toHaveBeenCalledWith(
      "hermes-pi-orchestrator:integration", { taskId: "task-1" },
    );
  });

  it("delivers validated queue and steer prompts through Pi", () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const sendUserMessage = vi.fn();
    activate({
      sendUserMessage,
      events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
    });

    handlers.get("hermes-orchestrator:prompt")?.({ message: "next", delivery: "followUp" });
    handlers.get("hermes-orchestrator:prompt")?.({ message: "adjust", delivery: "steer" });
    handlers.get("hermes-orchestrator:prompt")?.({ message: "bad", delivery: "fresh" });

    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "next", { deliverAs: "followUp" });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "adjust", { deliverAs: "steer" });
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });
});
