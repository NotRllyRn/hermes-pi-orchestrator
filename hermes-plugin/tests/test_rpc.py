import os
import stat

from pi_orchestrator.rpc import PiManager, assistant_text, build_pi_command
from pi_orchestrator.state import StateStore


def test_extracts_authoritative_assistant_text():
    event = {
        "message": {
            "content": [
                {"type": "thinking", "thinking": "secret"},
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"},
            ]
        }
    }
    assert assistant_text(event) == "first\nsecond"


def test_builds_local_command():
    assert build_pi_command("/tmp/s.jsonl", cwd="/work", model="gpt-5") == [
        "pi", "--mode", "rpc", "--session", "/tmp/s.jsonl", "--model", "gpt-5"
    ]


def test_builds_quoted_ssh_command():
    command = build_pi_command(
        "~/.hermes/pi sessions/s.jsonl", cwd="/work/tree with space", host="pi@server-c"
    )
    assert command[:6] == ["ssh", "-T", "pi@server-c", "--", "sh", "-lc"]
    assert "cd '/work/tree with space'" in command[6]
    assert '"$HOME"/' in command[6]
    assert "mkdir -p" in command[6]


def test_manager_runs_and_persists_rpc_session(tmp_path, monkeypatch):
    fake_pi = tmp_path / "fake-pi"
    fake_pi.write_text(
        """#!/usr/bin/env python3
import json, sys
session_file = sys.argv[sys.argv.index('--session') + 1]
for line in sys.stdin:
    command = json.loads(line)
    response = {'id': command.get('id'), 'type': 'response', 'command': command['type'], 'success': True}
    if command['type'] == 'get_state':
        response['data'] = {'sessionFile': session_file, 'isStreaming': False}
    print(json.dumps(response), flush=True)
    if command['type'] == 'prompt':
        print(json.dumps({'type': 'turn_end', 'message': {'content': [{'type': 'text', 'text': 'done'}]}}), flush=True)
        print(json.dumps({'type': 'agent_settled'}), flush=True)
"""
    )
    fake_pi.chmod(fake_pi.stat().st_mode | stat.S_IXUSR)
    monkeypatch.delenv("PI_ORCHESTRATOR_PI_HOST", raising=False)
    manager = PiManager(StateStore(tmp_path / "state"))
    manager.pi_bin = os.fspath(fake_pi)

    session = manager.start("telegram:42", os.fspath(tmp_path))
    assert session.status == "idle"

    manager.send("telegram:42", "do work")
    assert manager.wait("telegram:42", 2)
    saved = manager.store.get_session("telegram:42")
    assert saved and saved.status == "idle" and saved.last_result == "done"

    manager.stop_all()
