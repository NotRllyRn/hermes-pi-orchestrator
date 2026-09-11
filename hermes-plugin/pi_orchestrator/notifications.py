"""Durable asynchronous notification delivery outside the WebSocket reader."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, Protocol


class NotificationStore(Protocol):
    def pending_notifications(self, limit: int = 20) -> list[dict[str, Any]]: ...

    def mark_notification_sent(self, notification_id: str) -> None: ...

    def mark_notification_failed(self, notification_id: str, error: str) -> None: ...


class NotificationWorker:
    def __init__(self, store: NotificationStore, inject: Callable[[str, str], None]):
        self.store = store
        self.inject = inject
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="pi-notifications")
        self._thread.start()

    def notify(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=3)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(2)
            self._wake.clear()
            self.run_once()

    def run_once(self) -> None:
        """Deliver each due notification once per attempt; persist retry state."""
        for notification in self.store.pending_notifications():
            if self._stop.is_set():
                return
            try:
                self.inject(notification["message"], notification["route_session_key"])
            except Exception as exc:
                self.store.mark_notification_failed(notification["notification_id"], str(exc))
                break
            self.store.mark_notification_sent(notification["notification_id"])
