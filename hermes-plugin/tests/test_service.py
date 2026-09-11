from importlib import import_module

pytest = import_module("pytest")
Store = import_module("pi_orchestrator.store").Store
service_module = import_module("pi_orchestrator.service")
Orchestrator = service_module.Orchestrator
PolicyError = service_module.PolicyError


class Dashboard:
    base_url = "http://127.0.0.1:18000"
    connected = True
    last_error = None

    def __init__(self):
        self.sessions = {}
        self.sent = []
        self.spawned = []
        self.parallel = []
        self.integrated = []
        self.dirty = False

    def inspect_project(self, _path):
        return {
            "serverId": "server-c", "repoRoot": "/work/repo", "dirty": self.dirty,
            "sessions": list(self.sessions.values()),
        }

    def send_prompt(self, session_id, text, delivery=None):
        self.sent.append((session_id, text, delivery))

    def spawn(self, cwd, prompt):
        self.spawned.append((cwd, prompt))
        return {"type": "spawn_result", "success": True}

    def abort(self, session_id):
        self.sent.append((session_id, "abort", None))

    def diagnostics(self, session_id, kind, limit):
        return {"session": session_id, "kind": kind, "limit": limit}

    def parallel_spawn(self, payload):
        self.parallel.append(payload)
        return {
            "sessionId": "child-1", "sessionFile": "/sessions/child.jsonl",
            "worktreePath": "/repos/demo-worktree", "branch": "hermes/demo",
            "baseCommit": "abc123",
        }

    def child_review(self, task_id):
        return {"data": {"taskId": task_id, "git": {"changedPaths": ["file.py"]}}}

    def child_integrate(self, task_id, strategy):
        self.integrated.append((task_id, strategy))
        return {"state": "integrated", "annotationRecorded": True}


def setup_project(tmp_path, status="streaming"):
    store = Store(tmp_path / "state.db")
    dashboard = Dashboard()
    dashboard.sessions["s1"] = {
        "id": "s1",
        "cwd": "/work/repo",
        "sessionFile": "/sessions/s1.jsonl",
        "status": status,
    }
    project = store.register_project(
        server_id="server-c", repo_path="/work/repo", name="repo",
        primary_session_id="s1", primary_session_file="/sessions/s1.jsonl",
        route_session_key="telegram:42",
    )
    return store, dashboard, Orchestrator(store, dashboard), project


def test_busy_submit_has_no_side_effect_and_requires_later_explicit_turn(tmp_path):
    store, dashboard, service, _project = setup_project(tmp_path)
    first = store.capture_turn("hermes-1", "telegram:42", "Please implement feature X")

    pending = service.submit_task("repo", "feature X", route="telegram:42", hermes_session_id="hermes-1")

    assert pending["status"] == "decision_required"
    assert pending["side_effects"] is False
    assert dashboard.sent == []
    decision_id = pending["decision_id"]
    with pytest.raises(PolicyError, match="later user turn"):
        service.resolve_task(decision_id, "queue", hermes_session_id="hermes-1")

    second = store.capture_turn("hermes-1", "telegram:42", "Queue")
    assert second > first
    resolved = service.resolve_task(decision_id, "queue", hermes_session_id="hermes-1")
    assert resolved["status"] == "queued"
    assert dashboard.sent == [("s1", "feature X", "followUp")]


def test_ambiguous_choice_does_not_execute(tmp_path):
    store, dashboard, service, _project = setup_project(tmp_path)
    store.capture_turn("hermes-1", "telegram:42", "new task")
    pending = service.submit_task("repo", "feature X", route="telegram:42", hermes_session_id="hermes-1")
    store.capture_turn("hermes-1", "telegram:42", "queue or parallel")

    with pytest.raises(PolicyError, match="does not explicitly authorize"):
        service.resolve_task(pending["decision_id"], "parallel", hermes_session_id="hermes-1")
    assert dashboard.sent == []


def test_explicit_later_parallel_choice_starts_worker(tmp_path):
    store, dashboard, service, _project = setup_project(tmp_path)
    pending = service.submit_task(
        "repo", "new task", route="telegram:42", hermes_session_id="hermes-1"
    )
    store.capture_turn("hermes-1", "telegram:42", "Parallel")

    result = service.resolve_task(pending["decision_id"], "parallel", hermes_session_id="hermes-1")

    assert result["status"] == "running"
    assert result["task"]["worker_session_id"] == "child-1"
    assert dashboard.sent == []


def test_dirty_parallel_requires_a_second_later_choice(tmp_path):
    store, dashboard, service, _project = setup_project(tmp_path)
    dashboard.dirty = True
    store.capture_turn("hermes-1", "telegram:42", "new task")
    pending = service.submit_task(
        "repo", "new task", route="telegram:42", hermes_session_id="hermes-1"
    )
    store.capture_turn("hermes-1", "telegram:42", "Parallel")

    preflight = service.resolve_task(
        pending["decision_id"], "parallel", hermes_session_id="hermes-1"
    )

    assert preflight["status"] == "parallel_decision_required"
    assert preflight["side_effects"] is False
    assert dashboard.parallel == []
    with pytest.raises(PolicyError, match="later user turn"):
        service.resolve_parallel_preflight(
            pending["task_id"], "head", hermes_session_id="hermes-1"
        )
    store.capture_turn("hermes-1", "telegram:42", "Committed HEAD")
    result = service.resolve_parallel_preflight(
        pending["task_id"], "head", hermes_session_id="hermes-1"
    )
    assert result["status"] == "running"
    assert dashboard.parallel[0]["dirtyPolicy"] == "head"


def test_parallel_settle_waits_for_explicit_review_integration(tmp_path):
    store, dashboard, service, project = setup_project(tmp_path)
    task = store.create_task(
        project["project_id"], "child work", "running", "telegram:42", kind="parallel"
    )
    store.update_task(task["task_id"], worker_session_id="child-1")

    service.on_dashboard_message({
        "type": "dashboard_event", "sessionId": "child-1", "seq": 10,
        "event": {"eventType": "agent_settled", "data": {"text": "done"}},
    })

    reviewed = store.get_task(task["task_id"])
    assert reviewed["status"] == "awaiting_review"
    assert "file.py" in reviewed["review"]
    store.capture_turn("hermes-1", "telegram:42", "Merge the child")
    result = service.integrate_child(
        task["task_id"], "merge", hermes_session_id="hermes-1"
    )
    assert result["status"] == "integrated"
    assert dashboard.integrated == [(task["task_id"], "merge")]


def test_idle_primary_receives_fresh_prompt(tmp_path):
    _store, dashboard, service, _project = setup_project(tmp_path, status="idle")
    result = service.submit_task("repo", "serial work", route="telegram:42", hermes_session_id="hermes-1")
    assert result["status"] == "running"
    assert dashboard.sent == [("s1", "serial work", None)]


def test_multiple_existing_sessions_require_explicit_selection(tmp_path):
    store = Store(tmp_path / "state.db")
    dashboard = Dashboard()
    dashboard.sessions = {
        "s1": {"id": "s1", "cwd": "/work/repo", "sessionFile": "/s1", "status": "idle"},
        "s2": {"id": "s2", "cwd": "/work/repo", "sessionFile": "/s2", "status": "ended"},
    }
    service = Orchestrator(store, dashboard)
    result = service.register_project("/work/repo", None, None, "telegram:42")
    assert result["status"] == "selection_required"
    assert store.list_projects() == []


def test_settled_event_is_reduced_notified_and_deduplicated(tmp_path):
    store, _dashboard, service, project = setup_project(tmp_path)
    task = store.create_task(project["project_id"], "work", "running", "telegram:42")
    store.update_task(task["task_id"], worker_session_id="s1")
    message = {
        "type": "dashboard_event",
        "sessionId": "s1",
        "seq": 8,
        "event": {"eventType": "agent_settled", "data": {"text": "done"}},
    }
    service.on_dashboard_message(message)
    service.on_dashboard_message(message)

    saved = store.get_task(task["task_id"])
    assert saved and saved["status"] == "completed"
    assert len(store.pending_notifications()) == 1
    assert store.recent_activity("s1", 10)[0]["summary"] == "done"
