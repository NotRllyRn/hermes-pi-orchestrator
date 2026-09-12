import { useCallback, useEffect, useRef, useState } from "react";
import type { ChildReview, OrchestratorOverview, ParallelWorker } from "../shared/types.js";
import { control, fetchChildReview, fetchOverview } from "./api.js";

export function useOrchestrator(cwd: string, pollIntervalMs: number) {
  const [overview, setOverview] = useState<OrchestratorOverview | null>(null);
  const [selected, setSelected] = useState<ParallelWorker | null>(null);
  const [review, setReview] = useState<ChildReview | null>(null);
  const [message, setMessage] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const overviewRequest = useRef(0);
  const reviewRequest = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const requestId = ++overviewRequest.current;
    try {
      const next = await fetchOverview(cwd);
      if (requestId !== overviewRequest.current) return;
      setOverview(next);
      setSelected((current) => next.workers.find((worker) => worker.taskId === current?.taskId) ?? null);
      setFetchError("");
    } catch (cause) {
      if (requestId === overviewRequest.current) {
        setFetchError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [cwd]);

  useEffect(() => {
    overviewRequest.current += 1;
    reviewRequest.current += 1;
    setOverview(null);
    setSelected(null);
    setReview(null);
    setMessage("");
    setFetchError("");
    setActionError("");
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh]);

  const run = useCallback(async (action: () => Promise<unknown>, clearDraft = false) => {
    setPending(true);
    setActionError("");
    try {
      await action();
      if (clearDraft) setMessage("");
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [refresh]);

  async function reviewWorker(worker: ParallelWorker): Promise<void> {
    const requestId = ++reviewRequest.current;
    setSelected(worker);
    setReview(null);
    setActionError("");
    try {
      const next = await fetchChildReview(worker.taskId);
      if (requestId === reviewRequest.current) {
        setReview(next);
        await refresh();
      }
    } catch (cause) {
      if (requestId === reviewRequest.current) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  function submit(kind: "queue" | "steer"): void {
    if (!overview || !message.trim()) return;
    void run(() => control(cwd, { action: kind, sessionId: overview.primary?.sessionId, message }), true);
  }

  function abortWorker(worker: ParallelWorker): void {
    if (window.confirm("Abort this parallel worker now?")) {
      void run(() => control(cwd, { action: "abort", taskId: worker.taskId }));
    }
  }

  function openWorker(worker: ParallelWorker): void {
    reviewRequest.current += 1;
    setSelected(worker);
    setReview(null);
  }

  function closeWorker(): void {
    reviewRequest.current += 1;
    setSelected(null);
    setReview(null);
  }

  return {
    overview, selected, review, message, error: actionError || fetchError, pending,
    setMessage, refresh, submit, openWorker, reviewWorker, abortWorker, closeWorker,
  };
}
