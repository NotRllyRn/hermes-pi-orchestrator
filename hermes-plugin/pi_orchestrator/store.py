"""Restart-safe SQLite state for orchestration policy and event cursors."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  server_id TEXT NOT NULL,
  primary_session_id TEXT,
  primary_session_file TEXT,
  state_version INTEGER NOT NULL DEFAULT 1,
  route_session_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id, repo_path)
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'primary',
  worker_session_id TEXT,
  session_file TEXT,
  branch TEXT,
  worktree_path TEXT,
  base_commit TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  review TEXT,
  decision_id TEXT,
  route_session_key TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  project_version INTEGER NOT NULL,
  created_evidence_id INTEGER NOT NULL,
  producing_session_id TEXT NOT NULL DEFAULT '',
  route_session_key TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  choice TEXT,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS parallel_preflights (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  project_version INTEGER NOT NULL,
  created_evidence_id INTEGER NOT NULL,
  producing_session_id TEXT NOT NULL DEFAULT '',
  route_session_key TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  choice TEXT,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS turn_evidence (
  evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  hermes_session_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  user_message TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  session_id TEXT PRIMARY KEY,
  dashboard_instance TEXT NOT NULL DEFAULT '',
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_event_unique
  ON activity(session_id, seq) WHERE seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  task_id TEXT,
  route_session_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
"""


class Store:
    """Small synchronized SQLite repository; Pi transcripts remain on Server C."""

    def __init__(self, path: str | Path | None = None):
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
        self.path = Path(path) if path else home / "pi-orchestrator" / "state.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._db:
            self._db.executescript(_SCHEMA)
            self._migrate()

    def _migrate(self) -> None:
        """Apply additive migrations for databases created by earlier plugin builds."""
        decision_columns = {
            row["name"] for row in self._db.execute("PRAGMA table_info(decisions)").fetchall()
        }
        if "producing_session_id" not in decision_columns:
            self._db.execute(
                "ALTER TABLE decisions ADD COLUMN producing_session_id TEXT NOT NULL DEFAULT ''"
            )
        if "route_session_key" not in decision_columns:
            self._db.execute(
                "ALTER TABLE decisions ADD COLUMN route_session_key TEXT NOT NULL DEFAULT ''"
            )
        task_columns = {
            row["name"] for row in self._db.execute("PRAGMA table_info(tasks)").fetchall()
        }
        if "kind" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'primary'")
        if "session_file" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN session_file TEXT")
        if "branch" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN branch TEXT")
        if "worktree_path" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN worktree_path TEXT")
        if "base_commit" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN base_commit TEXT")
        if "cost_usd" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0")
        if "review" not in task_columns:
            self._db.execute("ALTER TABLE tasks ADD COLUMN review TEXT")
        notification_columns = {
            row["name"] for row in self._db.execute("PRAGMA table_info(notifications)").fetchall()
        }
        if "attempt_count" not in notification_columns:
            self._db.execute(
                "ALTER TABLE notifications ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0"
            )
        if "next_attempt_at" not in notification_columns:
            self._db.execute(
                "ALTER TABLE notifications ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0"
            )
        if "last_error" not in notification_columns:
            self._db.execute("ALTER TABLE notifications ADD COLUMN last_error TEXT")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @staticmethod
    def project_id(server_id: str, repo_path: str) -> str:
        digest = hashlib.sha256(f"{server_id}\0{repo_path}".encode()).hexdigest()[:20]
        return f"prj_{digest}"

    def register_project(
        self,
        *,
        server_id: str,
        repo_path: str,
        name: str,
        primary_session_id: str | None = None,
        primary_session_file: str | None = None,
        route_session_key: str | None = None,
    ) -> dict[str, Any]:
        timestamp = now_ms()
        project_id = self.project_id(server_id, repo_path)
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO projects
                   (project_id,name,repo_path,server_id,primary_session_id,primary_session_file,
                    route_session_key,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(project_id) DO UPDATE SET
                     name=excluded.name,
                     primary_session_id=COALESCE(excluded.primary_session_id,projects.primary_session_id),
                     primary_session_file=COALESCE(excluded.primary_session_file,projects.primary_session_file),
                     route_session_key=COALESCE(excluded.route_session_key,projects.route_session_key),
                     updated_at=excluded.updated_at""",
                (
                    project_id, name, repo_path, server_id, primary_session_id,
                    primary_session_file, route_session_key, timestamp, timestamp,
                ),
            )
        return self.get_project(project_id) or {}

    def get_project(self, reference: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                """SELECT * FROM projects WHERE project_id=? OR repo_path=? OR name=?
                   ORDER BY updated_at DESC LIMIT 1""",
                (reference, reference, reference),
            ).fetchone()
        return dict(row) if row else None

    def list_projects(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM projects ORDER BY name,project_id").fetchall()
        return [dict(row) for row in rows]

    def bind_primary(self, project_id: str, session: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._db:
            self._db.execute(
                """UPDATE projects SET primary_session_id=?,primary_session_file=?,
                   state_version=state_version+1,updated_at=? WHERE project_id=?""",
                (session.get("id"), session.get("sessionFile"), now_ms(), project_id),
            )
        return self.get_project(project_id) or {}

    def touch_route(self, project_id: str, session_key: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "UPDATE projects SET route_session_key=?,updated_at=? WHERE project_id=?",
                (session_key, now_ms(), project_id),
            )

    def capture_turn(self, hermes_session_id: str, session_key: str, user_message: str) -> int:
        with self._lock, self._db:
            cursor = self._db.execute(
                "INSERT INTO turn_evidence(hermes_session_id,session_key,user_message,captured_at) VALUES(?,?,?,?)",
                (hermes_session_id, session_key, user_message, now_ms()),
            )
            evidence_id = cursor.lastrowid
            if evidence_id is None:
                raise RuntimeError("SQLite did not return an evidence id")
            return evidence_id

    def latest_evidence(self, hermes_session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM turn_evidence WHERE hermes_session_id=? ORDER BY evidence_id DESC LIMIT 1",
                (hermes_session_id,),
            ).fetchone()
        return dict(row) if row else None

    def create_task(
        self,
        project_id: str,
        task: str,
        status: str,
        route_session_key: str | None,
        kind: str = "primary",
    ) -> dict[str, Any]:
        task_id = new_id("task")
        timestamp = now_ms()
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO tasks
                   (task_id,project_id,task,status,kind,route_session_key,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (task_id, project_id, task, status, kind, route_session_key, timestamp, timestamp),
            )
        return self.get_task(task_id) or {}

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def update_task(self, task_id: str, **changes: Any) -> dict[str, Any] | None:
        current = self.get_task(task_id)
        if not current:
            return None
        allowed = {
            "status", "kind", "worker_session_id", "session_file", "branch", "worktree_path",
            "base_commit", "cost_usd", "review", "decision_id", "result", "error",
            "route_session_key",
        }
        current.update({key: value for key, value in changes.items() if key in allowed})
        with self._lock, self._db:
            self._db.execute(
                """UPDATE tasks SET status=?,kind=?,worker_session_id=?,session_file=?,branch=?,
                   worktree_path=?,base_commit=?,cost_usd=?,review=?,decision_id=?,result=?,error=?,
                   route_session_key=?,updated_at=? WHERE task_id=?""",
                (
                    current["status"], current["kind"], current["worker_session_id"],
                    current["session_file"], current["branch"], current["worktree_path"],
                    current["base_commit"], current["cost_usd"], current["review"],
                    current["decision_id"], current["result"], current["error"],
                    current["route_session_key"], now_ms(), task_id,
                ),
            )
        return self.get_task(task_id)

    def list_tasks(self, project_id: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM tasks"
        params: tuple[Any, ...] = ()
        if project_id:
            query += " WHERE project_id=?"
            params = (project_id,)
        query += " ORDER BY created_at DESC"
        with self._lock:
            rows = self._db.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def create_decision(
        self,
        task: dict[str, Any],
        project_version: int,
        evidence_id: int,
        producing_session_id: str,
        route_session_key: str,
        ttl_seconds: int = 900,
    ) -> dict[str, Any]:
        decision_id = new_id("decision")
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO decisions
                   (decision_id,task_id,project_id,project_version,created_evidence_id,
                    producing_session_id,route_session_key,expires_at,status)
                   VALUES(?,?,?,?,?,?,?,?, 'pending')""",
                (
                    decision_id, task["task_id"], task["project_id"], project_version,
                    evidence_id, producing_session_id, route_session_key,
                    now_ms() + ttl_seconds * 1000,
                ),
            )
            self._db.execute(
                "UPDATE tasks SET decision_id=?,status='decision_required',updated_at=? WHERE task_id=?",
                (decision_id, now_ms(), task["task_id"]),
            )
        return self.get_decision(decision_id) or {}

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM decisions WHERE decision_id=?", (decision_id,)).fetchone()
        return dict(row) if row else None

    def resolve_decision(self, decision_id: str, choice: str) -> dict[str, Any]:
        with self._lock, self._db:
            self._db.execute(
                """UPDATE decisions SET status='resolved',choice=?,resolved_at=?
                   WHERE decision_id=? AND status='pending'""",
                (choice, now_ms(), decision_id),
            )
        return self.get_decision(decision_id) or {}

    def create_parallel_preflight(
        self,
        task: dict[str, Any],
        project_version: int,
        evidence_id: int,
        producing_session_id: str,
        route_session_key: str,
        ttl_seconds: int = 900,
    ) -> dict[str, Any]:
        with self._lock, self._db:
            self._db.execute(
                """INSERT OR REPLACE INTO parallel_preflights
                   (task_id,project_id,project_version,created_evidence_id,
                    producing_session_id,route_session_key,expires_at,status)
                   VALUES(?,?,?,?,?,?,?,'pending')""",
                (
                    task["task_id"], task["project_id"], project_version, evidence_id,
                    producing_session_id, route_session_key, now_ms() + ttl_seconds * 1000,
                ),
            )
            self._db.execute(
                "UPDATE tasks SET status='parallel_decision_required',updated_at=? WHERE task_id=?",
                (now_ms(), task["task_id"]),
            )
        return self.get_parallel_preflight(task["task_id"]) or {}

    def get_parallel_preflight(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM parallel_preflights WHERE task_id=?", (task_id,)
            ).fetchone()
        return dict(row) if row else None

    def resolve_parallel_preflight(self, task_id: str, choice: str) -> dict[str, Any]:
        with self._lock, self._db:
            self._db.execute(
                """UPDATE parallel_preflights SET status='resolved',choice=?,resolved_at=?
                   WHERE task_id=? AND status='pending'""",
                (choice, now_ms(), task_id),
            )
        return self.get_parallel_preflight(task_id) or {}

    def save_cursor(self, session_id: str, seq: int, dashboard_instance: str = "") -> None:
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO cursors(session_id,dashboard_instance,last_seq,updated_at) VALUES(?,?,?,?)
                   ON CONFLICT(session_id) DO UPDATE SET dashboard_instance=excluded.dashboard_instance,
                     last_seq=MAX(cursors.last_seq,excluded.last_seq),updated_at=excluded.updated_at""",
                (session_id, dashboard_instance, seq, now_ms()),
            )

    def cursor(self, session_id: str) -> int:
        with self._lock:
            row = self._db.execute("SELECT last_seq FROM cursors WHERE session_id=?", (session_id,)).fetchone()
        return row["last_seq"] if row else 0

    def add_activity(
        self, session_id: str, kind: str, summary: str, *, seq: int | None = None, payload: Any = None
    ) -> bool:
        with self._lock, self._db:
            cursor = self._db.execute(
                """INSERT OR IGNORE INTO activity(session_id,seq,kind,summary,payload_json,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (session_id, seq, kind, summary[:1000], json.dumps(payload or {}), now_ms()),
            )
            return cursor.rowcount == 1

    def recent_activity(self, session_id: str, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """SELECT session_id,seq,kind,summary,created_at FROM activity
                   WHERE session_id=? ORDER BY activity_id DESC LIMIT ?""",
                (session_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def enqueue_notification(self, task_id: str | None, route: str, kind: str, message: str) -> str:
        notification_id = new_id("note")
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO notifications(notification_id,task_id,route_session_key,kind,message,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (notification_id, task_id, route, kind, message, now_ms()),
            )
        return notification_id

    def get_notification(self, notification_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM notifications WHERE notification_id=?", (notification_id,)
            ).fetchone()
        return dict(row) if row else None

    def pending_notifications(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """SELECT * FROM notifications
                   WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?""",
                (now_ms(), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_notification_sent(self, notification_id: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                """UPDATE notifications SET status='sent',sent_at=?,last_error=NULL
                   WHERE notification_id=? AND status='pending'""",
                (now_ms(), notification_id),
            )

    def mark_notification_failed(self, notification_id: str, error: str) -> None:
        with self._lock, self._db:
            row = self._db.execute(
                "SELECT attempt_count FROM notifications WHERE notification_id=?",
                (notification_id,),
            ).fetchone()
            if not row:
                return
            attempts = row["attempt_count"] + 1
            status = "failed" if attempts >= 8 else "pending"
            delay_ms = min(300_000, (2 ** min(attempts, 8)) * 1_000)
            self._db.execute(
                """UPDATE notifications SET status=?,attempt_count=?,next_attempt_at=?,last_error=?
                   WHERE notification_id=?""",
                (status, attempts, now_ms() + delay_ms, error[:1000], notification_id),
            )
