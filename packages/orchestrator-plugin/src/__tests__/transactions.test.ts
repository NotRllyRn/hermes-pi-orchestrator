import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TransactionJournal } from "../server/transactions.js";

describe("parallel transaction journal", () => {
  it("persists request phases and completed identities across restart", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "orchestrator-journal-")), "journal.json");
    const first = new TransactionJournal(file);
    first.put({ taskId: "task-1", projectId: "project-1", state: "preparing" });
    first.update("task-1", { state: "sending", sessionId: "session-1" });

    const restarted = new TransactionJournal(file);

    expect(restarted.get("task-1")).toEqual(expect.objectContaining({
      state: "sending", sessionId: "session-1",
    }));
  });

  it("fails closed when persisted JSON is malformed", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "orchestrator-journal-")), "journal.json");
    writeFileSync(file, "not json");
    expect(() => new TransactionJournal(file)).toThrow("journal is unreadable");
  });
});
