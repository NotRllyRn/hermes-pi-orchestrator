"""Authenticated HTTP control plane consumed by the dashboard server plugin."""

from __future__ import annotations

import hmac
import json
import os
import threading
from dataclasses import asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .state import StateStore

_MAX_BODY = 1024 * 1024


class ControlApi:
    def __init__(
        self,
        manager: Any,
        queue: Any,
        store: StateStore,
        bind: str | None = None,
        token: str | None = None,
    ):
        self.manager = manager
        self.queue = queue
        self.store = store
        self.bind = bind if bind is not None else os.environ.get(
            "PI_ORCHESTRATOR_API_BIND", "127.0.0.1:8787"
        )
        self.token = token if token is not None else os.environ.get("PI_ORCHESTRATOR_API_TOKEN", "")
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> bool:
        if not self.bind or self.bind.lower() in {"off", "disabled"}:
            return False
        host, separator, raw_port = self.bind.rpartition(":")
        if not separator or not host or not raw_port.isdigit():
            raise ValueError("PI_ORCHESTRATOR_API_BIND must be host:port")
        if host not in {"127.0.0.1", "localhost", "::1"} and not self.token:
            raise ValueError("PI_ORCHESTRATOR_API_TOKEN is required for a non-loopback bind")
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                api._handle(self)

            def do_POST(self) -> None:
                api._handle(self)

            def log_message(self, format: str, *args: Any) -> None:
                del format, args

        try:
            self.server = ThreadingHTTPServer((host, int(raw_port)), Handler)
        except OSError as exc:
            raise RuntimeError(f"Could not bind orchestrator API at {self.bind}: {exc}") from exc
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True, name="pi-orchestrator-api"
        )
        self.thread.start()
        return True

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=5)
        self.server = None
        self.thread = None

    @property
    def address(self) -> tuple[str, int] | None:
        if not self.server:
            return None
        host, port = self.server.server_address[:2]
        return str(host), port

    def _handle(self, request: BaseHTTPRequestHandler) -> None:
        if self.token:
            supplied = request.headers.get("Authorization", "").removeprefix("Bearer ")
            if not hmac.compare_digest(supplied, self.token):
                self._send(request, HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
                return
        try:
            body = self._body(request) if request.command == "POST" else {}
            status, payload = self._route(request.command, urlsplit(request.path).path, body)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            status, payload = HTTPStatus.BAD_REQUEST, {"error": str(exc)}
        except Exception as exc:
            status, payload = HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)}
        self._send(request, status, payload)

    def _body(self, request: BaseHTTPRequestHandler) -> dict[str, Any]:
        try:
            length = int(request.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length must be an integer") from exc
        if length > _MAX_BODY:
            raise ValueError("Request body is too large")
        try:
            raw = request.rfile.read(length)
        except OSError as exc:
            raise ValueError("Could not read request body") from exc
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            raise ValueError("Request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise TypeError("Request body must be an object")
        return body

    def _route(
        self, method: str, path: str, body: dict[str, Any]
    ) -> tuple[HTTPStatus, Any]:
        if method == "GET" and path == "/health":
            return HTTPStatus.OK, {"ok": True}
        if method == "GET" and path == "/sessions":
            return HTTPStatus.OK, [self.manager.status(item.session_key) for item in self.store.list_sessions()]
        if method == "GET" and path == "/queue":
            return HTTPStatus.OK, [asdict(task) for task in self.store.list_tasks()]
        if method == "POST" and path == "/sessions/start":
            session = self.manager.start(
                self._string(body, "session_key"), self._string(body, "working_dir"),
                self._optional_string(body, "model"), self._optional_string(body, "thinking"),
            )
            return HTTPStatus.OK, asdict(session)
        if method == "POST" and path == "/sessions/send":
            session = self.manager.send(
                self._string(body, "session_key"), self._string(body, "message"),
                self._optional_string(body, "streaming_behavior") or "followUp",
            )
            return HTTPStatus.ACCEPTED, asdict(session)
        if method == "POST" and path == "/sessions/stop":
            session = self.manager.stop(self._string(body, "session_key"))
            return HTTPStatus.OK, {"stopped": bool(session)}
        if method == "POST" and path == "/queue":
            task = self.queue.enqueue(
                self._string(body, "prompt"), self._string(body, "working_dir"),
                self._optional_string(body, "model"), self._integer(body, "priority"),
                self._optional_string(body, "session_key"),
            )
            return HTTPStatus.ACCEPTED, asdict(task)
        if method == "POST" and path == "/queue/cancel":
            task = self.queue.cancel(self._string(body, "task_id"))
            return HTTPStatus.OK, asdict(task) if task else {"error": "Task not found"}
        return HTTPStatus.NOT_FOUND, {"error": "Not found"}

    @staticmethod
    def _integer(body: dict[str, Any], key: str) -> int:
        value = body.get(key, 0)
        if not isinstance(value, int):
            raise TypeError(f"{key} must be an integer")
        return value

    @staticmethod
    def _string(body: dict[str, Any], key: str) -> str:
        value = body.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} must be a non-empty string")
        return value

    @staticmethod
    def _optional_string(body: dict[str, Any], key: str) -> str | None:
        value = body.get(key)
        if value is None:
            return None
        if not isinstance(value, str):
            raise TypeError(f"{key} must be a string")
        return value or None

    @staticmethod
    def _send(request: BaseHTTPRequestHandler, status: HTTPStatus, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        request.send_response(status)
        request.send_header("Content-Type", "application/json; charset=utf-8")
        request.send_header("Content-Length", str(len(data)))
        request.end_headers()
        request.wfile.write(data)
