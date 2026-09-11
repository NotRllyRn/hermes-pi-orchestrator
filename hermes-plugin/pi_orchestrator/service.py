"""Orchestration policy boundary over PI Dashboard's control plane."""

from __future__ import annotations

from collections import Counter
from typing import Any

from .choice_parser import parse_choice
from .dashboard.client import DashboardClient
from .reducer import SIGNIFICANT_EVENTS, compact_project, event_summary, worker_state
from .store import Store, now_ms


class PolicyError(RuntimeError):
    pass


class Orchestrator:
    def __init__(self, store: Store, dashboard: DashboardClient, decision_ttl_seconds: int = 900):
        self.store = store
        self.dashboard = dashboard
        self.decision_ttl_seconds = decision_ttl_seconds

    def projects(self) -> list[dict[str, Any]]:
        return [self.project_status(item["project_id"]) for item in self.store.list_projects()]

    def register_project(
        self, repo_path: str, name: str | None, session_id: str | None, route: str | None
    ) -> dict[str, Any]:
        info = self.dashboard.inspect_project(repo_path)
        canonical = info.get("repoRoot")
        if not isinstance(canonical, str) or not canonical:
            raise PolicyError("Dashboard did not return a canonical repository root")
        candidates = [item for item in info.get("sessions", []) if isinstance(item, dict)]
        selected = None
        if session_id:
            selected = next((item for item in candidates if item.get("id") == session_id), None)
            if not selected:
                raise PolicyError("Requested primary session is not associated with this repository")
        elif len(candidates) == 1:
            selected = candidates[0]
        elif len(candidates) > 1:
            return {
                "status": "selection_required",
                "repo_path": canonical,
                "sessions": [self._session_choice(item) for item in candidates],
                "message": "Choose one existing session_id explicitly; no primary was bound.",
            }
        project = self.store.register_project(
            server_id=str(info.get("serverId") or self.dashboard.base_url),
            repo_path=canonical,
            name=name or canonical.rstrip("/").rsplit("/", 1)[-1],
            primary_session_id=selected.get("id") if selected else None,
            primary_session_file=selected.get("sessionFile") if selected else None,
            route_session_key=route,
        )
        return {"status": "bound" if selected else "unbound", "project": project}

    @staticmethod
    def _session_choice(session: dict[str, Any]) -> dict[str, Any]:
        return {
            "session_id": session.get("id"),
            "session_file": session.get("sessionFile"),
            "status": session.get("status"),
            "started_at": session.get("startedAt"),
            "model": session.get("model"),
        }

    def project_status(self, reference: str) -> dict[str, Any]:
        project = self._project(reference)
        session = self.dashboard.sessions.get(project.get("primary_session_id", ""))
        activity = self.store.recent_activity(project.get("primary_session_id") or "", 5)
        counts = Counter(task["status"] for task in self.store.list_tasks(project["project_id"]))
        result = compact_project(project, session, activity, dict(counts))
        result["transport"] = {
            "dashboard_connected": self.dashboard.connected,
            "error": self.dashboard.last_error,
        }
        return result

    def submit_task(
        self,
        reference: str,
        task_text: str,
        *,
        route: str | None,
        hermes_session_id: str,
    ) -> dict[str, Any]:
        project = self._project(reference)
        if route:
            self.store.touch_route(project["project_id"], route)
        session_id = project.get("primary_session_id")
        session = self.dashboard.sessions.get(session_id) if session_id else None
        state = worker_state(session)
        task = self.store.create_task(project["project_id"], task_text, "created", route)

        if not session_id:
            if not self.dashboard.connected:
                self.store.update_task(task["task_id"], status="failed", error="Dashboard disconnected")
                raise PolicyError("Project is unbound and Dashboard is disconnected")
            response = self.dashboard.spawn(project["repo_path"], task_text)
            self.store.update_task(task["task_id"], status="starting")
            return {"status": "starting_primary", "task_id": task["task_id"], "dashboard": response}

        if state in {"working", "waiting_input", "retry_wait"}:
            evidence = self.store.latest_evidence(hermes_session_id)
            evidence_id = evidence.get("evidence_id", 0) if evidence else 0
            project_version = project.get("state_version", 0)
            if not isinstance(evidence_id, int) or not isinstance(project_version, int):
                raise PolicyError("Stored policy state is invalid")
            decision = self.store.create_decision(
                task, project_version, evidence_id, self.decision_ttl_seconds
            )
            return {
                "status": "decision_required",
                "task_id": task["task_id"],
                "decision_id": decision["decision_id"],
                "choices": ["Queue", "Steer", "Parallel"],
                "side_effects": False,
                "message": "Ask the user to choose Queue, Steer, or Parallel. Resolve only on a later explicit user turn.",
            }
        if state in {"degraded", "disconnected"}:
            self.store.update_task(task["task_id"], status="blocked", error=f"Primary is {state}")
            raise PolicyError(f"Primary session is {state}; inspect status before mutation")

        self.dashboard.send_prompt(session_id, task_text)
        self.store.update_task(task["task_id"], status="running", worker_session_id=session_id)
        return {"status": "running", "task_id": task["task_id"], "worker_session_id": session_id}

    def validate_resolution(
        self,
        decision_id: str,
        choice: str,
        *,
        hermes_session_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        decision = self.store.get_decision(decision_id)
        if not decision or decision["status"] != "pending":
            raise PolicyError("Decision is missing or no longer pending")
        if decision["expires_at"] < now_ms():
            raise PolicyError("Decision expired; submit the task again")
        project = self._project(decision["project_id"])
        if project["state_version"] != decision["project_version"]:
            raise PolicyError("Project state changed after the decision was created")
        evidence = self.store.latest_evidence(hermes_session_id)
        if not evidence or evidence["evidence_id"] <= decision["created_evidence_id"]:
            raise PolicyError("Queue/Steer/Parallel requires a later user turn")
        parsed = parse_choice(str(evidence["user_message"]))
        normalized = choice.lower().strip()
        if parsed != normalized:
            raise PolicyError("Latest raw user message does not explicitly authorize this single choice")
        task = self.store.get_task(decision["task_id"])
        if not task:
            raise PolicyError("Decision task is missing")
        return decision, project, task

    def resolve_task(
        self, decision_id: str, choice: str, *, hermes_session_id: str
    ) -> dict[str, Any]:
        decision, project, task = self.validate_resolution(
            decision_id, choice, hermes_session_id=hermes_session_id
        )
        session_id = project.get("primary_session_id")
        if not session_id:
            raise PolicyError("Project has no primary session")
        normalized = choice.lower().strip()
        if normalized == "queue":
            self.dashboard.send_prompt(session_id, task["task"], "followUp")
            status = "queued"
            result: dict[str, Any] = {"worker_session_id": session_id}
        elif normalized == "steer":
            self.dashboard.send_prompt(session_id, task["task"], "steer")
            status = "running"
            result = {"worker_session_id": session_id}
        elif normalized == "parallel":
            payload = {
                "projectId": project["project_id"],
                "taskId": task["task_id"],
                "repoRoot": project["repo_path"],
                "prompt": task["task"],
            }
            result = self.dashboard.parallel_spawn(payload)
            status = "running"
        else:
            raise PolicyError("Choice must be queue, steer, or parallel")
        self.store.resolve_decision(decision["decision_id"], normalized)
        updated = self.store.update_task(
            task["task_id"], status=status,
            worker_session_id=result.get("sessionId") or result.get("worker_session_id"),
        )
        return {"status": status, "task": updated, "dashboard": result}

    def worker_send(self, session_id: str, message: str, delivery: str | None) -> dict[str, Any]:
        if session_id not in self.dashboard.sessions:
            raise PolicyError("Unknown Dashboard session")
        self.dashboard.send_prompt(session_id, message, delivery)
        return {"accepted": True, "worker_session_id": session_id, "delivery": delivery or "fresh"}

    def abort(self, session_id: str) -> dict[str, Any]:
        self.dashboard.abort(session_id)
        return {"aborted": True, "worker_session_id": session_id}

    def recent_activity(self, session_id: str, limit: int) -> list[dict[str, Any]]:
        if limit < 1 or limit > 50:
            raise PolicyError("limit must be between 1 and 50")
        return self.store.recent_activity(session_id, limit)

    def diagnostics(self, session_id: str, kind: str, limit: int) -> Any:
        if limit < 1 or limit > 200:
            raise PolicyError("limit must be between 1 and 200")
        return self.dashboard.diagnostics(session_id, kind, limit)

    def on_dashboard_message(self, message: dict[str, Any]) -> None:
        if message.get("type") == "session_added":
            self._bind_started_session(message)
            return
        if message.get("type") != "dashboard_event":
            return
        session_id = message["sessionId"]
        event = message["event"]
        kind = str(event.get("eventType") or "event")
        if kind in SIGNIFICANT_EVENTS:
            inserted = self.store.add_activity(
                session_id, kind, event_summary(event), seq=message["seq"], payload=event.get("data")
            )
            if inserted and kind in {"agent_settled", "extension_error", "prompt_request", "retry_exhausted"}:
                self._notify_event(session_id, kind, event_summary(event))
        if kind == "agent_settled":
            for task in self.store.list_tasks():
                if task.get("worker_session_id") == session_id and task["status"] in {"running", "queued"}:
                    self.store.update_task(task["task_id"], status="completed", result=event_summary(event))

    def _bind_started_session(self, message: dict[str, Any]) -> None:
        session = message.get("session")
        if not isinstance(session, dict):
            return
        for project in self.store.list_projects():
            if project.get("primary_session_id") is None and project["repo_path"] == session.get("cwd"):
                self.store.bind_primary(project["project_id"], session)
                starting = next(
                    (task for task in self.store.list_tasks(project["project_id"]) if task["status"] == "starting"),
                    None,
                )
                if starting:
                    self.store.update_task(starting["task_id"], status="running", worker_session_id=session["id"])
                break

    def _notify_event(self, session_id: str, kind: str, summary: str) -> None:
        task = next(
            (item for item in self.store.list_tasks() if item.get("worker_session_id") == session_id),
            None,
        )
        if not task or not task.get("route_session_key"):
            return
        self.store.enqueue_notification(
            task["task_id"], task["route_session_key"], kind,
            f"Pi task {task['task_id']} — {kind.replace('_', ' ')}: {summary}",
        )

    def _project(self, reference: str) -> dict[str, Any]:
        project = self.store.get_project(reference)
        if not project:
            raise PolicyError(f"Unknown project: {reference}")
        return project
