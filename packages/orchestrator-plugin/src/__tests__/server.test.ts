import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boundedJson, canonicalRepository, redact } from "../server/index.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("Server C safety helpers", () => {
  it("canonicalizes repositories inside an allowed root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-root-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init");
    expect(canonicalRepository(repo, [root])).toBe(repo);
  });

  it("rejects a symlink escape from an allowed root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orchestrator-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "orchestrator-outside-"));
    git(outside, "init");
    const link = path.join(root, "escape");
    symlinkSync(outside, link);
    expect(() => canonicalRepository(link, [root])).toThrow("outside configured allowedRoots");
  });

  it("redacts nested secrets and bounds diagnostics", () => {
    expect(redact({ token: "abc", nested: { apiKey: "def", safe: "ok" } })).toEqual({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "ok" },
    });
    expect(boundedJson([{ text: "x".repeat(500) }], 32)).toEqual({ data: [], truncated: true });
  });
});
