"""Small, durable JSON state store shared by plugin tools and hooks."""

from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

SessionStatus = Literal["idle", "busy", "paused", "error", "stopped"]
TaskStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PiSession:
    session_key: str
    pi_session_file: str
    cwd: str
    model: str | None = None
    thinking: str | None = None
    status: SessionStatus = "idle"
    created_at: str = field(default_factory=now)
    updated_at: str = field(default_factory=now)
    last_active_at: str = field(default_factory=now)
    last_result: str = ""
    error: str | None = None


@dataclass
class QueueTask:
    prompt: str
    working_dir: str
    model: str | None = None
    priority: int = 0
    task_id: str = field(default_factory=lambda: uuid4().hex[:12])
    status: TaskStatus = "queued"
    created_at: str = field(default_factory=now)
    updated_at: str = field(default_factory=now)
    result: str = ""
    error: str | None = None
    session_key: str | None = None


class StateStore:
    """Thread-safe atomic persistence beneath ``~/.hermes/pi-orchestrator``."""

    def __init__(self, root: str | Path | None = None):
        hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
        self.root = Path(root) if root else hermes_home / "pi-orchestrator"
        self.sessions_dir = self.root / "sessions"
        self.queue_path = self.root / "queue.json"
        self.pi_sessions_dir = self.root / "pi-sessions"
        self._lock = threading.RLock()
        for path in (self.sessions_dir, self.pi_sessions_dir):
            path.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _read(path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return default

    @staticmethod
    def _write(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.{uuid4().hex}.tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        os.replace(temporary, path)

    def _session_path(self, session_key: str) -> Path:
        digest = hashlib.sha256(session_key.encode()).hexdigest()
        return self.sessions_dir / f"{digest}.json"

    def pi_session_path(self, session_key: str) -> Path:
        digest = hashlib.sha256(session_key.encode()).hexdigest()
        return self.pi_sessions_dir / f"{digest}.jsonl"

    def get_session(self, session_key: str) -> PiSession | None:
        with self._lock:
            data = self._read(self._session_path(session_key), None)
            return PiSession(**data) if data else None

    def save_session(self, session: PiSession) -> PiSession:
        with self._lock:
            session.updated_at = now()
            self._write(self._session_path(session.session_key), asdict(session))
            return session

    def list_sessions(self) -> list[PiSession]:
        with self._lock:
            sessions = [PiSession(**data) for path in self.sessions_dir.glob("*.json") if (data := self._read(path, None))]
            return sorted(sessions, key=lambda item: item.updated_at, reverse=True)

    def add_task(self, task: QueueTask) -> QueueTask:
        with self._lock:
            tasks = self.list_tasks()
            tasks.append(task)
            self._save_tasks(tasks)
            return task

    def list_tasks(self) -> list[QueueTask]:
        with self._lock:
            return [QueueTask(**item) for item in self._read(self.queue_path, [])]

    def get_task(self, task_id: str) -> QueueTask | None:
        return next((task for task in self.list_tasks() if task.task_id == task_id), None)

    def update_task(self, task_id: str, **changes: Any) -> QueueTask | None:
        with self._lock:
            tasks = self.list_tasks()
            task = next((item for item in tasks if item.task_id == task_id), None)
            if not task:
                return None
            for key, value in changes.items():
                if hasattr(task, key):
                    setattr(task, key, value)
            task.updated_at = now()
            self._save_tasks(tasks)
            return task

    def next_task(self) -> QueueTask | None:
        queued = [task for task in self.list_tasks() if task.status == "queued"]
        return min(queued, key=lambda item: (-item.priority, item.created_at), default=None)

    def _save_tasks(self, tasks: list[QueueTask]) -> None:
        self._write(self.queue_path, [asdict(task) for task in tasks])
