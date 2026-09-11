"""Hermes plugin registration and tool handlers."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict
from importlib import import_module
from typing import Any

from .api import ControlApi
from .rpc import PiManager
from .state import QueueTask, StateStore

QueueWorker = import_module(f"{__package__}.queue").QueueWorker
TOOLS = import_module(f"{__package__}.schemas").TOOLS

_store: StateStore | None = None
_manager: PiManager | None = None
_queue: Any = None
_api: ControlApi | None = None


def _session_key(kwargs: dict[str, Any]) -> str:
    try:
        get_session_env = import_module("gateway.session_context").get_session_env
        stable = get_session_env("HERMES_SESSION_KEY", "")
        if stable:
            return stable
    except ImportError:
        pass
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "local")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _error(exc: Exception) -> str:
    return _json({"error": str(exc), "error_type": type(exc).__name__})


def _available() -> bool:
    return bool(shutil.which("ssh" if os.environ.get("PI_ORCHESTRATOR_PI_HOST") else os.environ.get("PI_ORCHESTRATOR_PI_BIN", "pi")))


def register_plugin(ctx) -> None:
    """Register all tools and lifecycle hooks through Hermes' public plugin API."""
    global _store, _manager, _queue, _api
    store = _store = StateStore()

    def inject(content: str, session_key: str | None) -> None:
        if not session_key:
            return
        try:
            ctx.inject_message(content, session_key=session_key)
        except Exception:
            return

    def on_pi_event(session_key: str, event: dict[str, Any]) -> None:
        if event.get("type") != "agent_settled" or session_key.startswith("queue:"):
            return
        session = store.get_session(session_key)
        if session:
            inject(f"Pi finished its task:\n\n{session.last_result}", session_key)

    def on_queue_complete(task: QueueTask) -> None:
        message = (
            f"Queued Pi task {task.task_id} completed:\n\n{task.result}"
            if task.status == "completed"
            else f"Queued Pi task {task.task_id} failed: {task.error}"
        )
        inject(message, task.session_key)

    manager = _manager = PiManager(store, on_pi_event)
    queue_worker = _queue = QueueWorker(manager, store, on_queue_complete)
    for task in store.list_tasks():
        if task.status == "running":
            store.update_task(task.task_id, status="queued", error="Recovered after restart")
    queue_worker.start()
    api = _api = ControlApi(manager, queue_worker, store)
    api.start()

    def pi_start(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            session = manager.start(
                _session_key(kwargs), args["working_dir"], args.get("model"), args.get("thinking")
            )
            return _json({"started": True, **asdict(session)})
        except Exception as exc:
            return _error(exc)

    def pi_send(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            session = manager.send(
                _session_key(kwargs), args["message"], args.get("streaming_behavior", "followUp")
            )
            return _json({"accepted": True, "status": session.status, "session_key": session.session_key})
        except Exception as exc:
            return _error(exc)

    def pi_status(_args: dict[str, Any], **kwargs: Any) -> str:
        return _json(manager.status(_session_key(kwargs)))

    def pi_stop(_args: dict[str, Any], **kwargs: Any) -> str:
        session = manager.stop(_session_key(kwargs))
        return _json({"stopped": bool(session), "session": asdict(session) if session else None})

    def pi_queue(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            task = queue_worker.enqueue(
                args["prompt"], args["working_dir"], args.get("model"),
                int(args.get("priority", 0)), _session_key(kwargs),
            )
            return _json({"queued": True, **asdict(task)})
        except Exception as exc:
            return _error(exc)

    def pi_queue_status(args: dict[str, Any], **_kwargs: Any) -> str:
        task_id = args.get("task_id")
        if task_id:
            task = store.get_task(task_id)
            return _json(asdict(task) if task else {"error": "Task not found"})
        return _json([asdict(task) for task in store.list_tasks()])

    handlers = {
        "pi_start": pi_start,
        "pi_send": pi_send,
        "pi_status": pi_status,
        "pi_stop": pi_stop,
        "pi_queue": pi_queue,
        "pi_queue_status": pi_queue_status,
    }
    for name, handler in handlers.items():
        ctx.register_tool(
            name=name,
            toolset="pi_orchestrator",
            schema=TOOLS[name],
            handler=handler,
            check_fn=_available,
            description=TOOLS[name]["description"],
            emoji="🥧",
        )

    def pre_llm_call(**_kwargs: Any) -> None:
        manager.reconcile()

    def post_llm_call(**_kwargs: Any) -> None:
        manager.reconcile()

    def cleanup() -> None:
        api.stop()
        queue_worker.shutdown()
        manager.stop_all()

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.on_unload(cleanup)
