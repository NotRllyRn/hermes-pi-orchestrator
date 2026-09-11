interface PiLike {
  appendEntry?: (customType: string, data?: unknown) => void;
  events?: { on?: (name: string, handler: (data: unknown) => void) => void };
}

/** Persist integration metadata in the primary Pi JSONL without adding LLM context. */
export default function activate(context: unknown): void {
  const candidate = context as { pi?: PiLike } | PiLike;
  const pi = ((candidate as { pi?: PiLike }).pi ?? candidate) as PiLike;
  if (typeof pi.appendEntry !== "function" || typeof pi.events?.on !== "function") return;
  pi.events.on("hermes-orchestrator:integration", (data) => {
    pi.appendEntry?.("hermes-pi-orchestrator:integration", data);
  });
}
