"""Persistent Pi RPC subprocesses, optionally transported over SSH."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from .state import PiSession, StateStore, now

EventCallback = Callable[[str, dict[str, Any]], None]


def assistant_text(event: dict[str, Any]) -> str:
    """Extract assistant text from an authoritative Pi message event."""
    message = event.get("message") or {}
    content = message.get("content") or []
    if isinstance(content, str):
        return content
    return "\n".join(
        str(block.get("text", ""))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    )


def build_pi_command(
    session_file: str,
    *,
    cwd: str = ".",
    model: str | None = None,
    thinking: str | None = None,
    host: str | None = None,
    pi_bin: str = "pi",
) -> list[str]:
    """Build a local command or a non-interactive SSH transport command."""
    args = [pi_bin, "--mode", "rpc", "--session", session_file]
    if model:
        args += ["--model", model]
    if thinking:
        args += ["--thinking", thinking]
    if not host:
        return args
    rendered = [shlex.quote(arg) for arg in args]
    if session_file.startswith("~/"):
        rendered[4] = '"$HOME"/' + shlex.quote(session_file[2:])
    session_dir = session_file.rsplit("/", 1)[0]
    rendered_dir = (
        '"$HOME"/' + shlex.quote(session_dir[2:])
        if session_dir.startswith("~/")
        else shlex.quote(session_dir)
    )
    remote = (
        f"cd {shlex.quote(cwd)} && mkdir -p {rendered_dir} && "
        f"exec {' '.join(rendered)}"
    )
    return ["ssh", "-T", host, "--", "sh", "-lc", remote]


class RpcProcess:
    """A single Pi JSONL process with correlated command responses."""

    def __init__(
        self,
        command: list[str],
        cwd: str,
        on_event: Callable[[dict[str, Any]], None],
        spawn: Callable[..., subprocess.Popen] = subprocess.Popen,
    ):
        self.command = command
        self.cwd = cwd
        self.on_event = on_event
        self._responses: dict[str, dict[str, Any]] = {}
        self._condition = threading.Condition()
        self._stderr: deque[str] = deque(maxlen=40)
        self._closed = False
        self.process = spawn(
            command,
            cwd=None if command[0] == "ssh" else cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    @property
    def running(self) -> bool:
        return not self._closed and self.process.poll() is None

    @property
    def stderr(self) -> str:
        return "".join(self._stderr)[-4000:]

    def command_request(self, command: dict[str, Any], timeout: float = 15) -> dict[str, Any]:
        request_id = command.setdefault("id", uuid4().hex)
        self.send(command)
        deadline = time.monotonic() + timeout
        with self._condition:
            while request_id not in self._responses and self.running:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(remaining)
            response = self._responses.pop(request_id, None)
        if response is None:
            detail = self.stderr.strip() or "Pi did not respond"
            raise TimeoutError(detail)
        if not response.get("success"):
            raise RuntimeError(str(response.get("error") or "Pi rejected the command"))
        return response

    def send(self, command: dict[str, Any]) -> None:
        if not self.running or not self.process.stdin:
            raise RuntimeError(self.stderr.strip() or "Pi session is not running")
        payload = json.dumps(command, ensure_ascii=False).encode() + b"\n"
        self.process.stdin.write(payload)
        self.process.stdin.flush()

    def stop(self) -> None:
        if not self.running:
            return
        try:
            self.command_request({"type": "abort"}, timeout=10)
        except (RuntimeError, TimeoutError, OSError):
            pass
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self._closed = True
        with self._condition:
            self._condition.notify_all()

    def _read_stdout(self) -> None:
        stream = self.process.stdout
        if stream is None:
            return
        buffer = b""
        read_chunk = getattr(stream, "read1", stream.read)
        while chunk := read_chunk(4096):
            buffer += chunk
            while b"\n" in buffer:
                raw, buffer = buffer.split(b"\n", 1)
                self._handle_line(raw[:-1] if raw.endswith(b"\r") else raw)
        if buffer:
            self._handle_line(buffer[:-1] if buffer.endswith(b"\r") else buffer)
        self._closed = True
        with self._condition:
            self._condition.notify_all()

    def _read_stderr(self) -> None:
        if not self.process.stderr:
            return
        read_chunk = getattr(self.process.stderr, "read1", self.process.stderr.read)
        while chunk := read_chunk(4096):
            self._stderr.append(chunk.decode(errors="replace"))

    def _handle_line(self, raw: bytes) -> None:
        try:
            event = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        request_id = event.get("id")
        if event.get("type") == "response" and request_id:
            with self._condition:
                self._responses[str(request_id)] = event
                self._condition.notify_all()
        self.on_event(event)


class PiManager:
    """Own Pi processes and bind each one to a durable Hermes session key."""

    def __init__(
        self,
        store: StateStore | None = None,
        on_event: EventCallback | None = None,
        spawn: Callable[..., subprocess.Popen] = subprocess.Popen,
    ):
        self.store = store or StateStore()
        self.on_event = on_event or (lambda _key, _event: None)
        self.spawn = spawn
        self.host = os.environ.get("PI_ORCHESTRATOR_PI_HOST") or None
        self.pi_bin = os.environ.get("PI_ORCHESTRATOR_PI_BIN", "pi")
        self._processes: dict[str, RpcProcess] = {}
        self._settled: dict[str, threading.Event] = {}
        self._lock = threading.RLock()

    def start(
        self,
        session_key: str,
        cwd: str,
        model: str | None = None,
        thinking: str | None = None,
    ) -> PiSession:
        with self._lock:
            existing = self._processes.get(session_key)
            if existing and existing.running:
                session = self.store.get_session(session_key)
                if session:
                    return session
            session = self.store.get_session(session_key)
            session_file = session.pi_session_file if session else self._new_session_file(session_key)
            command = build_pi_command(
                session_file, cwd=cwd, model=model or (session.model if session else None),
                thinking=thinking or (session.thinking if session else None),
                host=self.host, pi_bin=self.pi_bin,
            )
            process = RpcProcess(
                command, cwd, lambda event: self._handle_event(session_key, event), self.spawn
            )
            self._processes[session_key] = process
            self._settled.setdefault(session_key, threading.Event()).set()
        try:
            state = process.command_request({"type": "get_state"})
        except Exception:
            process.stop()
            raise
        actual_file = str((state.get("data") or {}).get("sessionFile") or session_file)
        result = session or PiSession(session_key, actual_file, cwd)
        result.pi_session_file = actual_file
        result.cwd = cwd
        result.model = model or result.model
        result.thinking = thinking or result.thinking
        result.status = "idle"
        result.error = None
        return self.store.save_session(result)

    def send(self, session_key: str, message: str, behavior: str = "followUp") -> PiSession:
        process = self._require_process(session_key)
        session = self.store.get_session(session_key)
        if not session:
            raise KeyError(f"Unknown session: {session_key}")
        command: dict[str, Any] = {"type": "prompt", "message": message}
        if session.status == "busy":
            command["streamingBehavior"] = behavior
        session.status = "busy"
        session.last_active_at = now()
        session.error = None
        self._settled.setdefault(session_key, threading.Event()).clear()
        self.store.save_session(session)
        try:
            process.command_request(command)
        except Exception as exc:
            session.status = "error"
            session.error = str(exc)
            self.store.save_session(session)
            self._settled[session_key].set()
            raise
        return session

    def status(self, session_key: str) -> dict[str, Any]:
        session = self.store.get_session(session_key)
        if not session:
            return {"status": "not_started", "session_key": session_key}
        process = self._processes.get(session_key)
        return {
            **session.__dict__,
            "process_running": bool(process and process.running),
            "pid": process.process.pid if process and process.running else None,
            "stderr": process.stderr if process else "",
        }

    def stop(self, session_key: str) -> PiSession | None:
        process = self._processes.pop(session_key, None)
        if process:
            process.stop()
        session = self.store.get_session(session_key)
        if session:
            session.status = "stopped"
            self.store.save_session(session)
        self._settled.setdefault(session_key, threading.Event()).set()
        return session

    def wait(self, session_key: str, timeout: float | None = None) -> bool:
        return self._settled.setdefault(session_key, threading.Event()).wait(timeout)

    def stop_all(self) -> None:
        for session_key in list(self._processes):
            self.stop(session_key)

    def reconcile(self) -> None:
        """Mark unexpectedly exited busy processes as errors."""
        for session_key, process in list(self._processes.items()):
            if process.running:
                continue
            session = self.store.get_session(session_key)
            if session and session.status == "busy":
                session.status = "error"
                session.error = process.stderr.strip() or "Pi process exited unexpectedly"
                self.store.save_session(session)
                self._settled.setdefault(session_key, threading.Event()).set()

    def _new_session_file(self, session_key: str) -> str:
        name = self.store.pi_session_path(session_key).name
        if self.host:
            root = os.environ.get(
                "PI_ORCHESTRATOR_REMOTE_SESSION_DIR", "~/.hermes/pi-orchestrator/pi-sessions"
            )
            return f"{root.rstrip('/')}/{name}"
        return str(self.store.pi_session_path(session_key))

    def _require_process(self, session_key: str) -> RpcProcess:
        process = self._processes.get(session_key)
        if not process or not process.running:
            session = self.store.get_session(session_key)
            if not session:
                raise KeyError("Start Pi before sending a task")
            self.start(session_key, session.cwd, session.model, session.thinking)
            process = self._processes[session_key]
        return process

    def _handle_event(self, session_key: str, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        session = self.store.get_session(session_key)
        if session and event_type == "turn_end":
            text = assistant_text(event)
            if text:
                session.last_result = text
                session.last_active_at = now()
                self.store.save_session(session)
        elif session and event_type == "agent_settled":
            session.status = "idle"
            self.store.save_session(session)
            self._settled.setdefault(session_key, threading.Event()).set()
        elif session and event_type == "extension_error":
            session.error = str(event.get("error") or "Pi extension error")
            self.store.save_session(session)
        self.on_event(session_key, event)
