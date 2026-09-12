"""Headless PI Dashboard browser-protocol client."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from importlib import import_module
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from uuid import uuid4

MessageHandler = Callable[[dict[str, Any]], None]


class DashboardError(RuntimeError):
    pass


def websocket_url(base_url: str) -> str:
    parsed = urlparse(base_url.rstrip("/"))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunparse((scheme, parsed.netloc, "/ws", "", "", ""))


class DashboardClient:
    """Maintains snapshots, replay cursors, and one reconnecting WebSocket."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        cursor_for: Callable[[str], int] | None = None,
        save_cursor: Callable[[str, int], None] | None = None,
        on_message: MessageHandler | None = None,
    ):
        self.base_url = (base_url or os.environ.get("PI_DASHBOARD_URL", "http://127.0.0.1:18000")).rstrip("/")
        self.authorization_secret = os.environ.get("PI_ORCHESTRATOR_AUTH_SECRET")
        self.sessions: dict[str, dict[str, Any]] = {}
        self.connected = False
        self.last_error: str | None = None
        self._cursor_for = cursor_for or (lambda _session_id: 0)
        self._save_cursor = save_cursor or (lambda _session_id, _seq: None)
        self._on_message = on_message or (lambda _message: None)
        self._socket: Any = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._send_lock = threading.Lock()
        self._condition = threading.Condition()
        self._responses: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="pi-dashboard-ws")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        socket = self._socket
        if socket:
            try:
                socket.close()
            except Exception as exc:
                self.last_error = f"WebSocket close failed: {exc}"
        if self._thread:
            self._thread.join(timeout=3)

    def _run(self) -> None:
        delay = 1.0
        while not self._stop.is_set():
            try:
                create_connection = import_module("websocket").create_connection
                socket = create_connection(websocket_url(self.base_url), timeout=15)
                socket.settimeout(None)
                self._socket = socket
                self.connected = True
                self.last_error = None
                delay = 1.0
                while not self._stop.is_set():
                    raw = socket.recv()
                    if not raw:
                        raise DashboardError("Dashboard WebSocket closed")
                    self.ingest(json.loads(raw))
            except Exception as exc:
                self.connected = False
                self.last_error = str(exc)
            finally:
                socket = self._socket
                self._socket = None
                if socket:
                    try:
                        socket.close()
                    except Exception as exc:
                        self.last_error = f"WebSocket close failed: {exc}"
            if not self._stop.wait(delay):
                delay = min(delay * 2, 30.0)

    def ingest(self, message: dict[str, Any]) -> None:
        """Apply a server message. Public for deterministic protocol tests."""
        message_type = message.get("type")
        if message_type == "sessions_snapshot":
            sessions = message.get("sessions", [])
            self.sessions = {item["id"]: dict(item) for item in sessions if isinstance(item, dict) and item.get("id")}
            for session_id in self.sessions:
                self.subscribe(session_id)
        elif message_type == "session_added":
            session = message.get("session")
            if isinstance(session, dict) and session.get("id"):
                self.sessions[session["id"]] = dict(session)
                self.subscribe(session["id"])
        elif message_type == "session_updated":
            session_id = message.get("sessionId")
            if isinstance(session_id, str):
                self.sessions.setdefault(session_id, {"id": session_id}).update(message.get("updates") or {})
        elif message_type == "session_removed":
            session_id = message.get("sessionId")
            if isinstance(session_id, str) and session_id in self.sessions:
                self.sessions[session_id]["status"] = "ended"
        elif message_type == "event":
            self._ingest_event(message.get("sessionId"), message.get("seq"), message.get("event"))
        elif message_type == "event_replay":
            session_id = message.get("sessionId")
            for item in message.get("events") or []:
                if isinstance(item, dict):
                    self._ingest_event(session_id, item.get("seq"), item.get("event"))

        request_id = message.get("requestId") or message.get("spawnRequestId")
        if isinstance(request_id, str):
            with self._condition:
                self._responses[request_id] = message
                self._condition.notify_all()
        self._on_message(message)

    def _ingest_event(self, session_id: Any, seq: Any, event: Any) -> None:
        if not isinstance(session_id, str) or not isinstance(seq, int) or not isinstance(event, dict):
            return
        if seq <= self._cursor_for(session_id):
            return
        self._save_cursor(session_id, seq)
        self._on_message({"type": "dashboard_event", "sessionId": session_id, "seq": seq, "event": event})

    def send(self, message: dict[str, Any]) -> None:
        socket = self._socket
        if not socket or not self.connected:
            raise DashboardError(f"Dashboard browser WebSocket unavailable: {self.last_error or 'disconnected'}")
        with self._send_lock:
            socket.send(json.dumps(message))

    def subscribe(self, session_id: str) -> None:
        if self.connected:
            self.send({"type": "subscribe", "sessionId": session_id, "lastSeq": self._cursor_for(session_id)})

    def send_prompt(self, session_id: str, text: str, delivery: str | None = None) -> None:
        message: dict[str, Any] = {"type": "send_prompt", "sessionId": session_id, "text": text}
        if delivery:
            message["delivery"] = delivery
        self.send(message)

    def abort(self, session_id: str) -> None:
        self.send({"type": "abort", "sessionId": session_id})

    def spawn(self, cwd: str, initial_prompt: str, timeout: float = 60) -> dict[str, Any]:
        request_id = str(uuid4())
        self.send({"type": "spawn_session", "cwd": cwd, "initialPrompt": initial_prompt, "requestId": request_id})
        return self.wait_for(request_id, timeout)

    def wait_for(self, request_id: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._condition:
            while request_id not in self._responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DashboardError(f"Timed out waiting for Dashboard request {request_id}")
                self._condition.wait(remaining)
            return self._responses.pop(request_id)

    def health(self) -> dict[str, Any]:
        return self.rest("GET", "/api/health")

    def inspect_project(self, repo_path: str) -> dict[str, Any]:
        query = urlencode({"path": repo_path})
        return self.rest("GET", f"/api/hermes-orchestrator/project?{query}")

    def diagnostics(self, session_id: str, kind: str, limit: int) -> Any:
        query = urlencode({"kind": kind, "limit": limit})
        return self.rest("GET", f"/api/hermes-orchestrator/session/{quote(session_id, safe='')}/diagnostics?{query}")

    def parallel_authorize(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.rest("POST", "/api/hermes-orchestrator/parallel/authorize", payload, authenticated=True)

    def parallel_spawn(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.rest("POST", "/api/hermes-orchestrator/parallel", payload, authenticated=True)

    def child_review(self, task_id: str) -> dict[str, Any]:
        return self.rest("GET", f"/api/hermes-orchestrator/child/{quote(task_id, safe='')}/review")

    def child_integrate(self, task_id: str, strategy: str) -> dict[str, Any]:
        path = f"/api/hermes-orchestrator/child/{quote(task_id, safe='')}/integrate"
        return self.rest("POST", path, {"strategy": strategy}, authenticated=True)

    def rest(
        self, method: str, path: str, body: Any = None, *, authenticated: bool = False
    ) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        if authenticated:
            if not self.authorization_secret:
                raise DashboardError("PI_ORCHESTRATOR_AUTH_SECRET is not configured")
            headers["X-Hermes-Orchestrator-Authorization"] = self.authorization_secret
        request = Request(f"{self.base_url}{path}", data=data, method=method, headers=headers)
        try:
            with urlopen(request, timeout=15) as response:
                raw = response.read(1_048_577)
        except (HTTPError, URLError, TimeoutError) as exc:
            raise DashboardError(f"Dashboard {method} {path} failed: {exc}") from exc
        if len(raw) > 1_048_576:
            raise DashboardError("Dashboard response exceeded 1 MiB")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise DashboardError("Dashboard returned invalid JSON") from exc
