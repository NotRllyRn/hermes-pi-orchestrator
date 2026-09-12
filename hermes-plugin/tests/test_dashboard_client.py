from importlib import import_module

module = import_module("pi_orchestrator.dashboard.client")
pytest = import_module("pytest")
DashboardClient = module.DashboardClient
DashboardError = module.DashboardError
websocket_url = module.websocket_url


class Socket:
    def __init__(self):
        self.sent = []

    def send(self, raw):
        self.sent.append(raw)


def test_websocket_url_uses_browser_gateway():
    assert websocket_url("http://127.0.0.1:18000") == "ws://127.0.0.1:18000/ws"
    assert websocket_url("https://dash.example/") == "wss://dash.example/ws"


def test_snapshot_subscribes_from_durable_cursor():
    socket = Socket()
    client = DashboardClient(cursor_for=lambda _sid: 41)
    client.connected = True
    client._socket = socket

    client.ingest({"type": "sessions_snapshot", "sessions": [{"id": "s1", "cwd": "/repo"}], "orders": {}})

    assert client.sessions["s1"]["cwd"] == "/repo"
    assert '"lastSeq": 41' in socket.sent[0]


def test_dirty_authorization_requires_and_sends_private_secret(monkeypatch):
    monkeypatch.delenv("PI_ORCHESTRATOR_AUTH_SECRET", raising=False)
    client = DashboardClient()
    with pytest.raises(DashboardError, match="not configured"):
        client.parallel_authorize({"taskId": "task-1"})
    with pytest.raises(DashboardError, match="not configured"):
        client.child_integrate("task-1", "merge")

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self, _limit):
            return b'{"authorizationToken":"token"}'

    def open_request(request, timeout):
        assert timeout == 15
        headers = {key.lower(): value for key, value in request.header_items()}
        assert headers["x-hermes-orchestrator-authorization"] == "shared-secret"
        return Response()

    monkeypatch.setenv("PI_ORCHESTRATOR_AUTH_SECRET", "shared-secret")
    monkeypatch.setattr(module, "urlopen", open_request)
    client = DashboardClient()
    assert client.parallel_authorize({"taskId": "task-1"})["authorizationToken"] == "token"
    client.child_integrate("task-1", "merge")


def test_replay_cursor_discards_duplicates():
    cursors = {"s1": 2}
    seen = []
    client = DashboardClient(
        cursor_for=lambda sid: cursors.get(sid, 0),
        save_cursor=lambda sid, seq: cursors.__setitem__(sid, seq),
        on_message=seen.append,
    )
    client.ingest({
        "type": "event_replay",
        "sessionId": "s1",
        "events": [
            {"seq": 2, "event": {"eventType": "agent_start", "data": {}}},
            {"seq": 3, "event": {"eventType": "agent_settled", "data": {}}},
        ],
        "isLast": True,
    })

    reduced = [message for message in seen if message.get("type") == "dashboard_event"]
    assert [message["seq"] for message in reduced] == [3]
    assert cursors["s1"] == 3
