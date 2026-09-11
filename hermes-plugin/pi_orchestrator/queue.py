"""Serialized background task queue for Pi."""

from __future__ import annotations

import threading
from collections.abc import Callable

from .rpc import PiManager
from .state import QueueTask, StateStore

QueueCallback = Callable[[QueueTask], None]


class QueueWorker:
    def __init__(
        self,
        manager: PiManager,
        store: StateStore | None = None,
        on_complete: QueueCallback | None = None,
        task_timeout: float = 3600,
    ):
        self.manager = manager
        self.store = store or manager.store
        self.on_complete = on_complete or (lambda _task: None)
        self.task_timeout = task_timeout
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, daemon=True, name="pi-orchestrator-queue")
            self._thread.start()

    def enqueue(
        self,
        prompt: str,
        working_dir: str,
        model: str | None = None,
        priority: int = 0,
        session_key: str | None = None,
    ) -> QueueTask:
        task = self.store.add_task(
            QueueTask(
                prompt, working_dir, model=model, priority=priority, session_key=session_key
            )
        )
        self.start()
        self._wake.set()
        return task

    def cancel(self, task_id: str) -> QueueTask | None:
        task = self.store.get_task(task_id)
        if not task or task.status != "queued":
            return task
        return self.store.update_task(task_id, status="cancelled")

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            task = self.store.next_task()
            if not task:
                self._wake.wait(30)
                self._wake.clear()
                continue
            self._execute(task)

    def _execute(self, task: QueueTask) -> None:
        pi_session_key = f"queue:{task.task_id}"
        task = self.store.update_task(task.task_id, status="running") or task
        try:
            self.manager.start(pi_session_key, task.working_dir, task.model)
            self.manager.send(pi_session_key, task.prompt)
            if not self.manager.wait(pi_session_key, self.task_timeout):
                raise TimeoutError(f"Pi task exceeded {self.task_timeout:g} seconds")
            session = self.manager.store.get_session(pi_session_key)
            if not session or session.status == "error":
                raise RuntimeError((session.error if session else None) or "Pi task failed")
            task = self.store.update_task(
                task.task_id, status="completed", result=session.last_result
            ) or task
        except Exception as exc:
            failed = self.store.update_task(task.task_id, status="failed", error=str(exc))
            if failed:
                task = failed
        finally:
            self.manager.stop(pi_session_key)
        self.on_complete(task)
