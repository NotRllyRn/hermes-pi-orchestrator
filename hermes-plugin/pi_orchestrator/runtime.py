"""Hermes capability registration and lifecycle hooks."""

from __future__ import annotations

import json
from importlib import import_module
from typing import Any

DashboardClient = import_module(f"{__package__}.dashboard.client").DashboardClient
NotificationWorker = import_module(f"{__package__}.notifications").NotificationWorker
_service_module = import_module(f"{__package__}.service")
Orchestrator = _service_module.Orchestrator
PolicyError = _service_module.PolicyError
Store = import_module(f"{__package__}.store").Store
TOOLS = import_module(f"{__package__}.schemas").TOOLS
_store: Any = None
_dashboard: Any = None
_notifications: Any = None
_service: Any = None


def _session_key(kwargs: dict[str, Any]) -> str:
    try:
        get_session_env = import_module("gateway.session_context").get_session_env
        stable = get_session_env("HERMES_SESSION_KEY", "")
        if stable:
            return str(stable)
    except ImportError:
        pass
    return str(kwargs.get("session_id") or "local")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _integer(value: Any, key: str) -> int:
    if not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    return value


def register_plugin(ctx: Any) -> None:
    """Register policy tools and one headless Dashboard connection supervisor."""
    global _store, _dashboard, _notifications, _service
    store = _store = Store()
    holder: dict[str, Any] = {}

    def on_dashboard_message(message: dict[str, Any]) -> None:
        service = holder.get("service")
        if service:
            service.on_dashboard_message(message)
        notifications = holder.get("notifications")
        if notifications:
            notifications.notify()

    dashboard = _dashboard = DashboardClient(
        cursor_for=store.cursor,
        save_cursor=store.save_cursor,
        on_message=on_dashboard_message,
    )
    service = _service = Orchestrator(store, dashboard)
    holder["service"] = service

    def inject(message: str, session_key: str) -> None:
        ctx.inject_message(message, session_key=session_key)

    notifications = _notifications = NotificationWorker(store, inject)
    holder["notifications"] = notifications
    dashboard.start()
    notifications.start()

    def route(kwargs: dict[str, Any]) -> tuple[str, str]:
        return _session_key(kwargs), str(kwargs.get("session_id") or _session_key(kwargs))

    def pi_projects(_args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.projects())

    def pi_project_register(args: dict[str, Any], **kwargs: Any) -> str:
        session_key, _ = route(kwargs)
        return _json(service.register_project(
            args["repo_path"], args.get("project_name"), args.get("session_id"), session_key
        ))

    def pi_project_status(args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.project_status(args["project"]))

    def pi_task_submit(args: dict[str, Any], **kwargs: Any) -> str:
        session_key, hermes_session_id = route(kwargs)
        return _json(service.submit_task(
            args["project"], args["task"], route=session_key, hermes_session_id=hermes_session_id
        ))

    def pi_task_resolve(args: dict[str, Any], **kwargs: Any) -> str:
        _, hermes_session_id = route(kwargs)
        return _json(service.resolve_task(
            args["decision_id"], args["choice"], hermes_session_id=hermes_session_id
        ))

    def pi_task_abort(args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.abort(args["worker_id"]))

    def pi_worker_send(args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.worker_send(args["worker_id"], args["message"], args.get("delivery")))

    def pi_recent_activity(args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.recent_activity(args["worker_id"], _integer(args["limit"], "limit")))

    def pi_diagnostics(args: dict[str, Any], **_kwargs: Any) -> str:
        return _json(service.diagnostics(
            args["worker_id"], args["kind"], _integer(args["limit"], "limit")
        ))

    handlers = {
        "pi_projects": pi_projects,
        "pi_project_register": pi_project_register,
        "pi_project_status": pi_project_status,
        "pi_task_submit": pi_task_submit,
        "pi_task_resolve": pi_task_resolve,
        "pi_task_abort": pi_task_abort,
        "pi_worker_send": pi_worker_send,
        "pi_recent_activity": pi_recent_activity,
        "pi_diagnostics": pi_diagnostics,
    }

    def guarded(handler: Any):
        def invoke(args: dict[str, Any], **kwargs: Any) -> str:
            try:
                return handler(args, **kwargs)
            except Exception as exc:
                return _json({"error": str(exc), "error_type": type(exc).__name__})
        return invoke

    for name, handler in handlers.items():
        ctx.register_tool(
            name=name,
            toolset="pi_orchestrator",
            schema=TOOLS[name],
            handler=guarded(handler),
            check_fn=lambda: dashboard.connected,
            description=TOOLS[name]["description"],
            emoji="🥧",
        )

    def pre_llm_call(**kwargs: Any) -> None:
        user_message = kwargs.get("user_message")
        if not isinstance(user_message, str) or not user_message.strip():
            return
        hermes_session_id = str(kwargs.get("session_id") or _session_key(kwargs))
        store.capture_turn(hermes_session_id, _session_key(kwargs), user_message)

    def pre_tool_call(**kwargs: Any) -> dict[str, str] | None:
        if kwargs.get("tool_name") != "pi_task_resolve":
            return None
        args = kwargs.get("args")
        if not isinstance(args, dict):
            return {"action": "block", "message": "Invalid pi_task_resolve arguments"}
        try:
            service.validate_resolution(
                str(args.get("decision_id") or ""), str(args.get("choice") or ""),
                hermes_session_id=str(kwargs.get("session_id") or _session_key(kwargs)),
            )
        except PolicyError as exc:
            return {"action": "block", "message": str(exc)}
        return None

    def cleanup() -> None:
        dashboard.stop()
        notifications.stop()
        store.close()

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.on_unload(cleanup)
