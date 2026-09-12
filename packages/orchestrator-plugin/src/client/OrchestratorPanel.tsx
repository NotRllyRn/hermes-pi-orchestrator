import { usePluginConfig } from "@blackbelt-technology/dashboard-plugin-runtime/context";
import type React from "react";
import type { ChildReview, OrchestratorOverview, ParallelWorker } from "../shared/types.js";
import { decodeFolderPath } from "./folder-encoding.js";
import { useOrchestrator } from "./useOrchestrator.js";

const button = "rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40";
const input = "rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]";

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function WorkerTable({
  overview,
  onDetails,
}: {
  overview: OrchestratorOverview | null;
  onDetails: (worker: ParallelWorker) => void;
}): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded border border-[var(--border-subtle)]">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
          <tr>
            {['Worker', 'Task', 'Branch', 'State', 'Cost', 'Updated'].map((label) => <th key={label} scope="col" className="p-2">{label}</th>)}
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {overview?.primary ? (
            <tr className="border-t border-[var(--border-subtle)]">
              <td className="p-2 font-medium text-[var(--text-primary)]">Primary</td>
              <td className="p-2">Coordinator</td><td className="p-2">{overview.branch}</td>
              <td className="p-2">{overview.primary.status}</td><td className="p-2">{money(overview.primary.costUsd)}</td>
              <td className="p-2">live</td><td />
            </tr>
          ) : null}
          {overview?.workers.map((worker) => (
            <tr key={worker.taskId} className="border-t border-[var(--border-subtle)]">
              <td className="p-2 font-mono">{worker.sessionId?.slice(0, 12) ?? "pending"}</td>
              <td className="max-w-64 truncate p-2" title={worker.prompt}>{worker.prompt ?? worker.taskId}</td>
              <td className="p-2 font-mono">{worker.branch ?? "—"}</td>
              <td className={`p-2 ${worker.state === "failed" ? "text-red-400" : ["ready_for_review", "awaiting_review"].includes(worker.state) ? "text-amber-400" : ""}`}>{worker.state}</td>
              <td className="p-2">{money(worker.costUsd)}</td>
              <td className="p-2">{new Date(worker.updatedAt).toLocaleTimeString()}</td>
              <td className="p-2 text-right">
                <button type="button" className={button} onClick={() => onDetails(worker)}>Details</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!overview?.primary && !overview?.workers.length ? (
        <p className="p-6 text-center text-xs text-[var(--text-muted)]">No orchestrated workers for this project.</p>
      ) : null}
    </div>
  );
}

function WorkerDetail({
  worker,
  review,
  pending,
  onReview,
  onAbort,
  onClose,
}: {
  worker: ParallelWorker;
  review: ChildReview | null;
  pending: boolean;
  onReview: () => void;
  onAbort: () => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <aside className="space-y-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4" data-testid="worker-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-[var(--text-primary)]">{worker.prompt ?? worker.taskId}</h2>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">{worker.worktreePath}</p>
        </div>
        <button type="button" className={button} onClick={onClose}>Close</button>
      </div>
      {worker.error ? <p className="text-xs text-red-300">{worker.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending || !["ready_for_review", "awaiting_review"].includes(worker.state)} onClick={onReview}>Review</button>
        <button type="button" className={button} disabled={pending} onClick={onAbort}>Abort</button>
        {review && worker.state === "awaiting_review" ? (
          <span className="self-center text-xs text-[var(--text-muted)]">Ask Hermes to merge, cherry-pick, or retain this branch.</span>
        ) : null}
      </div>
      {review?.truncated ? <p className="text-xs text-amber-300">Review package truncated to bounded limits.</p> : null}
      {review ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="font-medium text-[var(--text-primary)]">Git review</h3>
            <p>{review.git.changedPaths.length} files · {review.git.commits.length} commits</p>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-primary)] p-2 text-[11px]">{review.git.diffStat || "No committed diff"}</pre>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-[var(--text-primary)]">Recent activity</h3>
            <ol className="max-h-52 space-y-1 overflow-auto text-[11px]">
              {review.recentEvents.map((event, index) => (
                <li key={`${index}-${String(event.eventType ?? "event")}`} className="rounded bg-[var(--bg-primary)] p-2">
                  {String(event.eventType ?? "event")}
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function OrchestratorPanel({
  params,
  onBack,
}: {
  params: Record<string, string>;
  onBack: () => void;
}): React.ReactElement {
  const cwd = decodeFolderPath(params.encodedCwd ?? "") ?? "";
  const { pollIntervalMs = 3000 } = usePluginConfig<{ pollIntervalMs?: number }>();
  const state = useOrchestrator(cwd, pollIntervalMs);
  const { overview, selected } = state;

  if (!cwd) return <div className="p-4 text-sm text-red-400">Invalid folder path.</div>;

  return (
    <section className="min-h-full space-y-4 p-4 text-sm text-[var(--text-secondary)]" data-testid="orchestrator-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" className={button} onClick={onBack}>← Back</button>
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Hermes Pi Orchestrator</h1>
            <p className="font-mono text-[11px] text-[var(--text-muted)]">{cwd}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span>{overview?.branch ?? "—"}{overview?.dirty ? " · dirty" : ""}</span>
          <span>{overview ? money(overview.projectCostUsd) : "$0.00"}</span>
          {overview?.attentionCount ? <span role="status" className="font-semibold text-amber-400">⚠ {overview.attentionCount}</span> : null}
          <button type="button" className={button} onClick={() => void state.refresh()}>Refresh</button>
        </div>
      </header>

      {state.error ? <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{state.error}</div> : null}
      {overview?.dirty ? (
        <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          Primary tree is dirty. Use Hermes for the required later-turn Committed HEAD choice before parallel work.
        </div>
      ) : null}

      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
        <input className={input} aria-label="Orchestrator task" placeholder="Describe the next coding task" value={state.message} onChange={(event) => state.setMessage(event.target.value)} />
        <button type="button" className={button} disabled={state.pending || !state.message.trim() || !overview?.primary} onClick={() => state.submit("queue")}>Queue</button>
        <button type="button" className={button} disabled={state.pending || !state.message.trim() || !overview?.primary} onClick={() => state.submit("steer")}>Steer</button>
      </div>

      <WorkerTable overview={overview} onDetails={state.openWorker} />
      {selected ? (
        <WorkerDetail
          worker={selected}
          review={state.review}
          pending={state.pending}
          onReview={() => void state.reviewWorker(selected)}
          onAbort={() => state.abortWorker(selected)}
          onClose={state.closeWorker}
        />
      ) : null}
    </section>
  );
}
