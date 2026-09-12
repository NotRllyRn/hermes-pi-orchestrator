interface PiLike {
  appendEntry?: (customType: string, data?: unknown) => void;
  sendUserMessage?: (
    message: string,
    options?: { deliverAs: "steer" | "followUp" },
  ) => void | Promise<void>;
  events?: { on?: (name: string, handler: (data: unknown) => void) => void };
}

/** Persist integration metadata in the primary Pi JSONL without adding LLM context. */
export default function activate(context: unknown): void {
  const candidate = context as { pi?: PiLike } | PiLike;
  const pi = ((candidate as { pi?: PiLike }).pi ?? candidate) as PiLike;
  if (typeof pi.events?.on !== "function") return;
  if (typeof pi.appendEntry === "function") {
    pi.events.on("hermes-orchestrator:integration", (data) => {
      pi.appendEntry?.("hermes-pi-orchestrator:integration", data);
    });
  }
  if (typeof pi.sendUserMessage === "function") {
    pi.events.on("hermes-orchestrator:prompt", (data) => {
      const prompt = data as { message?: unknown; delivery?: unknown };
      if (typeof prompt.message !== "string" || !["steer", "followUp"].includes(String(prompt.delivery))) return;
      try {
        const sent = pi.sendUserMessage?.(
          prompt.message,
          { deliverAs: prompt.delivery as "steer" | "followUp" },
        );
        void Promise.resolve(sent).catch(() => {});
      } catch {
        // Dashboard receives only event transmission status; Pi owns final delivery.
      }
    });
  }
}
