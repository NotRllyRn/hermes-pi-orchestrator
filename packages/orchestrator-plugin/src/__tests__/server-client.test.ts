import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorClient } from "../server/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("orchestrator server client", () => {
  it("keeps the bearer token on the server-side hop", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ session_key: "telegram:42" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOrchestratorClient("http://server-a:8787/", "secret");
    const sessions = await client.get<Array<{ session_key: string }>>("/sessions");

    expect(sessions[0]?.session_key).toBe("telegram:42");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://server-a:8787/sessions",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("forwards control payloads and reports upstream errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }))
      .mockResolvedValueOnce(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOrchestratorClient("http://server-a:8787", "secret");

    await client.post("/sessions/send", { session_key: "x", message: "continue" });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ session_key: "x", message: "continue" }),
    );
    await expect(client.get("/sessions")).rejects.toThrow("401");
  });
});
