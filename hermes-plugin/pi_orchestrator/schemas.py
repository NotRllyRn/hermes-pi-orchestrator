"""OpenAI function schemas exposed to Hermes."""


def schema(name: str, description: str, properties: dict, required: tuple[str, ...] = ()) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": list(required)},
    }


PROJECT = {"type": "string", "description": "Registered project id, name, or canonical repository path."}
SESSION_ID = {"type": "string", "description": "Known PI Dashboard session id."}

TOOLS = {
    "pi_projects": schema("pi_projects", "List registered projects with compact live status.", {}),
    "pi_project_register": schema(
        "pi_project_register",
        "Register a Server C Git repository and bind one unambiguous existing persistent Pi session.",
        {
            "repo_path": {"type": "string", "description": "Absolute repository path on Server C."},
            "project_name": {"type": "string"},
            "session_id": {"type": "string", "description": "Required when several existing sessions are eligible."},
        },
        ("repo_path",),
    ),
    "pi_project_status": schema(
        "pi_project_status", "Get deterministic low-context project, worker, usage, and transport status.",
        {"project": PROJECT}, ("project",),
    ),
    "pi_task_submit": schema(
        "pi_task_submit",
        "Submit new project work. Never accepts a concurrency strategy. Busy primaries return a side-effect-free Queue/Steer/Parallel decision.",
        {"project": PROJECT, "task": {"type": "string", "description": "Complete coding task."}},
        ("project", "task"),
    ),
    "pi_task_resolve": schema(
        "pi_task_resolve",
        "Resolve a pending busy-primary decision only after a later raw user turn explicitly chooses one option.",
        {
            "decision_id": {"type": "string"},
            "choice": {"type": "string", "enum": ["queue", "steer", "parallel"]},
        },
        ("decision_id", "choice"),
    ),
    "pi_parallel_resolve": schema(
        "pi_parallel_resolve",
        "Resolve a dirty-tree Parallel preflight only after a later user turn chooses Wait or Committed HEAD.",
        {
            "task_id": {"type": "string"},
            "choice": {"type": "string", "enum": ["wait", "head"]},
        },
        ("task_id", "choice"),
    ),
    "pi_task_abort": schema(
        "pi_task_abort", "Abort the current run of a known Dashboard worker without deleting its Pi session.",
        {"worker_id": SESSION_ID}, ("worker_id",),
    ),
    "pi_worker_send": schema(
        "pi_worker_send",
        "Expert escape hatch for messaging a known worker. Use pi_task_submit for independent project work so the human concurrency gate applies.",
        {
            "worker_id": SESSION_ID,
            "message": {"type": "string"},
            "delivery": {"type": "string", "enum": ["steer", "followUp"]},
        },
        ("worker_id", "message"),
    ),
    "pi_recent_activity": schema(
        "pi_recent_activity", "Read bounded reduced activity; never returns a full transcript.",
        {"worker_id": SESSION_ID, "limit": {"type": "integer", "minimum": 1, "maximum": 50}},
        ("worker_id", "limit"),
    ),
    "pi_diagnostics": schema(
        "pi_diagnostics", "Read an explicit bounded diagnostic slice from Dashboard.",
        {
            "worker_id": SESSION_ID,
            "kind": {"type": "string", "enum": ["events", "log"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        },
        ("worker_id", "kind", "limit"),
    ),
}
