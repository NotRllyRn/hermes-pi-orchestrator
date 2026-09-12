import { SlotPill } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { FolderDescriptor } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/slot-props.js";
import { mdiTransitConnectionVariant } from "@mdi/js";
import type React from "react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { fetchOverview } from "./api.js";
import { encodeFolderPath } from "./folder-encoding.js";

export function FolderOrchestratorSection({
  folder,
}: {
  folder: FolderDescriptor;
}): React.ReactElement {
  const [, navigate] = useLocation();
  const [attention, setAttention] = useState(0);
  const [workers, setWorkers] = useState(0);

  useEffect(() => {
    let active = true;
    setAttention(0);
    setWorkers(0);
    async function refresh(): Promise<void> {
      try {
        const overview = await fetchOverview(folder.cwd);
        if (active) {
          setAttention(overview.attentionCount);
          setWorkers(overview.workers.length);
        }
      } catch {
        // Keep the last known counts during transient polling failures.
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [folder.cwd]);

  return (
    <div data-testid="folder-orchestrator-section" onClick={(event) => event.stopPropagation()}>
      <SlotPill
        glyph={mdiTransitConnectionVariant}
        accent={attention ? "red" : "blue"}
        label="Orchestrator"
        activateTestId="folder-orchestrator-open"
        activateTitle="Open Hermes Pi orchestrator"
        onActivate={() => navigate(`/folder/${encodeFolderPath(folder.cwd)}/orchestrator`)}
      >
        <span>{workers}</span>
        <span className="text-[10px] text-[var(--text-tertiary)]">workers</span>
        {attention > 0 ? <span className="text-[10px] font-bold text-amber-400">⚠ {attention}</span> : null}
      </SlotPill>
    </div>
  );
}
