from importlib import import_module

Store = import_module("pi_orchestrator.store").Store


def test_project_binding_and_tasks_survive_reopen(tmp_path):
    path = tmp_path / "state.db"
    store = Store(path)
    project = store.register_project(server_id="server-c", repo_path="/work/repo", name="repo")
    store.bind_primary(project["project_id"], {"id": "session-1", "sessionFile": "/sessions/one.jsonl"})
    task = store.create_task(project["project_id"], "fix it", "running", "telegram:42")
    store.save_cursor("session-1", 9)
    store.close()

    reopened = Store(path)
    saved_project = reopened.get_project("repo")
    saved_task = reopened.get_task(task["task_id"])
    assert saved_project and saved_project["primary_session_id"] == "session-1"
    assert saved_task and saved_task["task"] == "fix it"
    assert reopened.cursor("session-1") == 9
    reopened.close()


def test_activity_deduplicates_replayed_sequence(tmp_path):
    store = Store(tmp_path / "state.db")
    assert store.add_activity("s1", "agent_settled", "done", seq=7)
    assert not store.add_activity("s1", "agent_settled", "done again", seq=7)
    assert store.recent_activity("s1", 10)[0]["summary"] == "done"
