from pi_orchestrator.state import PiSession, QueueTask, StateStore


def test_session_round_trip(tmp_path):
    store = StateStore(tmp_path)
    session = PiSession("telegram:42", "/tmp/pi.jsonl", "/work", model="gpt-5")

    store.save_session(session)

    assert store.get_session("telegram:42") == session
    assert store.list_sessions() == [session]


def test_session_key_cannot_escape_store(tmp_path):
    store = StateStore(tmp_path)
    store.save_session(PiSession("../../escape", "/tmp/pi.jsonl", "/work"))

    assert len(list(store.sessions_dir.glob("*.json"))) == 1
    assert not (tmp_path.parent / "escape.json").exists()


def test_queue_orders_priority_then_age(tmp_path):
    store = StateStore(tmp_path)
    low = QueueTask("low", "/work", priority=0, created_at="2026-01-01T00:00:00+00:00")
    newest = QueueTask("new", "/work", priority=5, created_at="2026-01-02T00:00:00+00:00")
    oldest = QueueTask("old", "/work", priority=5, created_at="2026-01-01T00:00:00+00:00")
    for task in (low, newest, oldest):
        store.add_task(task)

    next_task = store.next_task()
    assert next_task and next_task.task_id == oldest.task_id


def test_task_update_is_persisted(tmp_path):
    store = StateStore(tmp_path)
    task = store.add_task(QueueTask("do it", "/work"))

    changed = store.update_task(task.task_id, status="completed", result="done")

    assert changed and changed.status == "completed"
    saved = store.get_task(task.task_id)
    assert saved and saved.result == "done"


def test_unknown_task_update_is_safe(tmp_path):
    assert StateStore(tmp_path).update_task("missing", status="failed") is None
