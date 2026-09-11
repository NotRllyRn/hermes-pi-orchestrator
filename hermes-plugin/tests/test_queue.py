from importlib import import_module

from pi_orchestrator.state import PiSession, QueueTask, StateStore

QueueWorker = import_module("pi_orchestrator.queue").QueueWorker


class FakeManager:
    def __init__(self, store):
        self.store = store
        self.stopped = []

    def start(self, session_key, cwd, model=None):
        return self.store.save_session(PiSession(session_key, "/tmp/pi.jsonl", cwd, model=model))

    def send(self, session_key, _prompt):
        session = self.store.get_session(session_key)
        session.last_result = "queue result"
        session.status = "idle"
        return self.store.save_session(session)

    def wait(self, _session_key, _timeout):
        return True

    def stop(self, session_key):
        self.stopped.append(session_key)


def test_queue_worker_completes_task(tmp_path):
    store = StateStore(tmp_path)
    manager = FakeManager(store)
    completed = []
    worker = QueueWorker(manager, store, completed.append)
    task = store.add_task(QueueTask("work", "/repo", session_key="telegram:42"))

    worker._execute(task)

    saved = store.get_task(task.task_id)
    assert saved and saved.status == "completed"
    assert saved.result == "queue result"
    assert completed == [saved]
    assert manager.stopped == [f"queue:{task.task_id}"]


def test_cancel_only_changes_queued_tasks(tmp_path):
    store = StateStore(tmp_path)
    worker = QueueWorker(FakeManager(store), store)
    queued = store.add_task(QueueTask("work", "/repo"))
    running = store.add_task(QueueTask("work", "/repo", status="running"))

    cancelled = worker.cancel(queued.task_id)
    unchanged = worker.cancel(running.task_id)
    assert cancelled and cancelled.status == "cancelled"
    assert unchanged and unchanged.status == "running"
