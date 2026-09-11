import { usePluginConfig } from "@blackbelt-technology/dashboard-plugin-runtime/context";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type {
  OrchestratorSession,
  OrchestratorState,
  OrchestratorTask,
} from "../shared/types.js";
import { cancelTask, enqueueTask, fetchState, sessionAction } from "./api.js";

const buttonClass =
  "rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50";
const inputClass =
  "rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)]";

function statusClass(status: string): string {
  if (status === "busy" || status === "running") return "text-[var(--severity-info-fg)]";
  if (status === "completed" || status === "idle") return "text-[var(--severity-success-fg)]";
  if (status === "error" || status === "failed") return "text-[var(--severity-error-fg)]";
  return "text-[var(--text-muted)]";
}

function SessionCard({
  session,
  refresh,
}: {
  session: OrchestratorSession;
  refresh: () => Promise<void>;
}): React.ReactElement {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");

  async function act(action: "start" | "send" | "stop", body: Record<string, unknown>) {
    setPending(true);
    setActionError("");
    try {
      await sessionAction(action, { session_key: session.session_key, ...body });
      if (action === "send") setMessage("");
      await refresh();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-mono text-[12px] text-[var(--text-primary)]">{session.session_key}</div>
          <div className="text-[11px] text-[var(--text-muted)]">{session.cwd}</div>
        </div>
        <div className={`flex items-center gap-2 text-[12px] ${statusClass(session.status)}`}>
          <span aria-hidden="true">●</span>
          <span>{session.status}</span>
          {session.model ? <span className="text-[var(--text-muted)]">{session.model}</span> : null}
          {session.pid ? <span className="text-[var(--text-muted)]">PID {session.pid}</span> : null}
        </div>
      </div>

      {session.error || actionError ? (
        <p className="text-[12px] text-[var(--severity-error-fg)]">{actionError || session.error}</p>
      ) : null}
      {session.last_result ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-primary)] p-2 text-[11px] text-[var(--text-secondary)]">
          {session.last_result}
        </pre>
      ) : null}

      <div className="flex gap-2">
        <input
          className={`${inputClass} min-w-0 flex-1`}
          aria-label={`Message for ${session.session_key}`}
          placeholder="Send follow-up to Pi"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && message.trim()) void act("send", { message });
          }}
        />
        <button
          type="button"
          className={buttonClass}
          disabled={pending || !message.trim()}
          onClick={() => void act("send", { message })}
        >
          Send
        </button>
        {session.process_running ? (
          <button
            type="button"
            className={buttonClass}
            disabled={pending}
            onClick={() => void act("stop", {})}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass}
            disabled={pending}
            onClick={() =>
              void act("start", {
                working_dir: session.cwd,
                ...(session.model ? { model: session.model } : {}),
                ...(session.thinking ? { thinking: session.thinking } : {}),
              })
            }
          >
            Resume
          </button>
        )}
      </div>
    </article>
  );
}

function QueueRow({ task, refresh }: { task: OrchestratorTask; refresh: () => Promise<void> }) {
  return (
    <li className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 text-[12px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[var(--text-primary)]">{task.prompt}</p>
          <p className="truncate text-[11px] text-[var(--text-muted)]">
            {task.working_dir} · priority {task.priority}
          </p>
        </div>
        <span className={`shrink-0 ${statusClass(task.status)}`}>
          {task.status}
        </span>
      </div>
      {task.result ? (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--text-secondary)]">
          {task.result}
        </pre>
      ) : null}
      {task.error ? <p className="mt-1 text-[var(--severity-error-fg)]">{task.error}</p> : null}
      {task.status === "queued" ? (
        <button
          type="button"
          className={`${buttonClass} mt-2`}
          onClick={() => void cancelTask(task.task_id).then(refresh)}
        >
          Cancel
        </button>
      ) : null}
    </li>
  );
}

export function OrchestratorPanel(): React.ReactElement {
  const { pollIntervalMs = 3000 } = usePluginConfig<{ pollIntervalMs?: number }>();
  const [state, setState] = useState<OrchestratorState>({ connected: false, sessions: [], queue: [] });
  const [prompt, setPrompt] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchState());
    } catch (error) {
      setState({ connected: false, sessions: [], queue: [], error: String(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh]);

  async function enqueue(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !workingDir.trim()) return;
    setPending(true);
    try {
      await enqueueTask({ prompt, working_dir: workingDir });
      setPrompt("");
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: String(error) }));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-4 text-[13px] text-[var(--text-secondary)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={state.connected ? "text-[var(--severity-success-fg)]" : "text-[var(--severity-error-fg)]"}
          >
            ●
          </span>
          <span>{state.connected ? "Connected" : "Disconnected"}</span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {state.sessions.length} sessions · {state.queue.filter((task) => task.status === "queued").length} queued
          </span>
        </div>
        <button type="button" className={buttonClass} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {state.error ? (
        <div className="rounded-md border border-[var(--severity-error-border)] bg-[var(--severity-error-bg)] p-2 text-[12px] text-[var(--severity-error-fg)]">
          {state.error}
          <p className="mt-1 text-[var(--text-muted)]">
            Configure HERMES_ORCHESTRATOR_URL and HERMES_ORCHESTRATOR_TOKEN on the dashboard server.
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="font-medium text-[var(--text-primary)]">Persistent sessions</h3>
        {state.sessions.length ? (
          state.sessions.map((session) => (
            <SessionCard key={session.session_key} session={session} refresh={refresh} />
          ))
        ) : (
          <p className="text-[12px] text-[var(--text-muted)]">No Hermes-managed Pi sessions.</p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="font-medium text-[var(--text-primary)]">Task queue</h3>
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={enqueue}>
          <input
            className={inputClass}
            aria-label="Queued task"
            placeholder="Coding task"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <input
            className={inputClass}
            aria-label="Queued task working directory"
            placeholder="Working directory on Pi host"
            value={workingDir}
            onChange={(event) => setWorkingDir(event.target.value)}
          />
          <button className={buttonClass} type="submit" disabled={pending || !prompt.trim() || !workingDir.trim()}>
            Queue
          </button>
        </form>
        <ul className="space-y-2">
          {state.queue.map((task) => <QueueRow key={task.task_id} task={task} refresh={refresh} />)}
        </ul>
      </div>
    </section>
  );
}
