import json
from importlib import import_module
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pi_orchestrator.state import PiSession, StateStore

ControlApi = import_module("pi_orchestrator.api").ControlApi


class StubManager:
    def __init__(self, store):
        self.store = store

    def status(self, session_key):
        session = self.store.get_session(session_key)
        return session.__dict__ if session else {}

    def stop(self, session_key):
        return self.store.get_session(session_key)


class StubQueue:
    def cancel(self, _task_id):
        return None


def get_json(url, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with urlopen(Request(url, headers=headers), timeout=2) as response:
        return response.status, json.load(response)


def post_json(url, payload, token):
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=2) as response:
        return response.status, json.load(response)


def test_control_api_health_auth_and_sessions(tmp_path):
    store = StateStore(tmp_path)
    store.save_session(PiSession("telegram:42", "/tmp/pi.jsonl", "/work"))
    api = ControlApi(StubManager(store), StubQueue(), store, "127.0.0.1:0", "secret")
    api.start()
    assert api.address
    host, port = api.address
    base = f"http://{host}:{port}"
    try:
        try:
            get_json(f"{base}/health")
        except HTTPError as denied:
            assert denied.code == 401
        else:
            raise AssertionError("unauthenticated request was accepted")

        assert get_json(f"{base}/health", "secret") == (200, {"ok": True})
        status, sessions = get_json(f"{base}/sessions", "secret")
        assert status == 200 and sessions[0]["session_key"] == "telegram:42"
        assert post_json(f"{base}/sessions/stop", {"session_key": "telegram:42"}, "secret") == (
            200,
            {"stopped": True},
        )
    finally:
        api.stop()


def test_non_loopback_bind_requires_token(tmp_path):
    store = StateStore(tmp_path)
    api = ControlApi(StubManager(store), StubQueue(), store, "0.0.0.0:0", "")

    try:
        api.start()
    except ValueError as error:
        assert "TOKEN" in str(error)
    else:
        raise AssertionError("non-loopback API started without a token")
