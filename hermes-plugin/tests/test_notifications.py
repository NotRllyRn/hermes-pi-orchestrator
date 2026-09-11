from importlib import import_module

NotificationWorker = import_module("pi_orchestrator.notifications").NotificationWorker
Store = import_module("pi_orchestrator.store").Store


def test_sent_notification_is_not_replayed_after_restart(tmp_path):
    database = tmp_path / "state.db"
    store = Store(database)
    store.enqueue_notification("task-1", "telegram:42", "settled", "done")
    delivered = []
    NotificationWorker(store, lambda message, route: delivered.append((message, route))).run_once()
    store.close()

    reopened = Store(database)
    NotificationWorker(reopened, lambda message, route: delivered.append((message, route))).run_once()

    assert delivered == [("done", "telegram:42")]
    reopened.close()


def test_failed_delivery_persists_bounded_retry_state(tmp_path):
    store = Store(tmp_path / "state.db")
    notification_id = store.enqueue_notification(
        "task-1", "telegram:42", "attention", "needs input"
    )

    def fail(_message, _route):
        raise RuntimeError("gateway unavailable")

    NotificationWorker(store, fail).run_once()

    notification = store.get_notification(notification_id)
    assert notification is not None
    assert notification["status"] == "pending"
    assert notification["attempt_count"] == 1
    assert notification["last_error"] == "gateway unavailable"
    assert store.pending_notifications() == []
    store.close()
