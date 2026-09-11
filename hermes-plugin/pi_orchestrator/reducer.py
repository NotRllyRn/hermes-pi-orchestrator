"""Deterministic low-context projection of Dashboard sessions and Pi events."""

from __future__ import annotations

import json
from typing import Any

SIGNIFICANT_EVENTS = {
    "agent_start",
    "agent_end",
    "agent_settled",
    "tool_execution_start",
    "tool_execution_end",
    "session_before_compact",
    "session_compact",
    "extension_error",
    "prompt_request",
    "retry_scheduled",
    "retry_exhausted",
}


def worker_state(session: dict[str, Any] | None) -> str:
    if not session:
        return "disconnected"
    status = session.get("status")
    if status == "streaming":
        return "working"
    if status in {"active", "idle"}:
        return "idle"
    if status == "ended":
        return "inactive"
    return "degraded"


def event_summary(event: dict[str, Any]) -> str:
    kind = str(event.get("eventType") or "event")
    raw_data = event.get("data")
    data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
    if kind.startswith("tool_execution"):
        tool = data.get("toolName") or data.get("name") or data.get("tool") or "tool"
        result = data.get("isError") or data.get("error")
        return f"{kind}: {tool}{' failed' if result else ''}"
    if kind == "extension_error":
        return f"extension error: {data.get('message') or data.get('error') or 'unknown'}"
    if kind in {"agent_end", "agent_settled"}:
        text = data.get("text") or data.get("result") or data.get("message") or kind
        if not isinstance(text, str):
            text = json.dumps(text, ensure_ascii=False)
        return text[:1000]
    if kind == "prompt_request":
        return f"input needed: {data.get('prompt') or data.get('message') or 'Pi requested input'}"
    return kind.replace("_", " ")


def compact_project(
    project: dict[str, Any], session: dict[str, Any] | None, activity: list[dict[str, Any]], task_counts: dict[str, int]
) -> dict[str, Any]:
    return {
        "project_id": project["project_id"],
        "project": project["name"],
        "repo_path": project["repo_path"],
        "primary": {
            "session_id": project.get("primary_session_id"),
            "session_file": project.get("primary_session_file"),
            "state": worker_state(session),
            "current_tool": session.get("currentTool") if session else None,
            "model": session.get("model") if session else None,
            "context_pct": session.get("contextPercent") if session else None,
            "session_cost_usd": session.get("cost") if session else None,
            "tokens_in": session.get("tokensIn") if session else None,
            "tokens_out": session.get("tokensOut") if session else None,
        },
        "tasks": task_counts,
        "recent_activity": activity[:5],
        "state_version": project["state_version"],
    }
