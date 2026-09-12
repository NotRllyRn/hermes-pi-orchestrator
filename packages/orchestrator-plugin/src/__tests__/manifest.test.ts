import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../dashboard-plugin-runtime/src/manifest-validator.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const pkgPath = path.resolve(here, "..", "..", "package.json");

describe("orchestrator plugin manifest", () => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  const manifest = pkg["pi-dashboard-plugin"] as Record<string, unknown>;

  it("registers valid server, bridge, sidebar, and project-board entries", () => {
    const validated = validateManifest(manifest, "orchestrator");
    expect(validated.id).toBe("hermes-pi-orchestrator");
    expect(validated.server).toBeTruthy();
    expect(validated.bridge).toBeTruthy();
    expect(validated.client).toBeTruthy();
    expect(validated.claims.map((claim) => claim.slot)).toEqual([
      "sidebar-folder-section", "shell-overlay-route",
    ]);
  });
});
