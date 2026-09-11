"""OpenAI function schemas exposed to Hermes."""


def schema(name: str, description: str, properties: dict, required: tuple[str, ...] = ()) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(required),
        },
    }


STRING = {"type": "string"}
MODEL = {"type": "string", "description": "Optional Pi model pattern or provider/model ID."}

PI_START = schema(
    "pi_start",
    "Start or reconnect the persistent Pi coding session bound to this Hermes conversation.",
    {
        "working_dir": {"type": "string", "description": "Project directory on the Pi host."},
        "model": MODEL,
        "thinking": {
            "type": "string",
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
    },
    ("working_dir",),
)

PI_SEND = schema(
    "pi_send",
    "Send work to this conversation's persistent Pi session and return after Pi accepts it.",
    {
        "message": {"type": "string", "description": "Complete coding instruction for Pi."},
        "streaming_behavior": {
            "type": "string",
            "enum": ["followUp", "steer"],
            "default": "followUp",
        },
    },
    ("message",),
)

PI_STATUS = schema(
    "pi_status",
    "Inspect this conversation's persistent Pi status and latest result.",
    {},
)

PI_STOP = schema(
    "pi_stop",
    "Stop this conversation's Pi process while retaining its resumable session file.",
    {},
)

PI_QUEUE = schema(
    "pi_queue",
    "Add a standalone coding task to the global serialized Pi queue.",
    {
        "prompt": {"type": "string", "description": "Complete coding task."},
        "working_dir": {"type": "string", "description": "Project directory on the Pi host."},
        "model": MODEL,
        "priority": {"type": "integer", "default": 0},
    },
    ("prompt", "working_dir"),
)

PI_QUEUE_STATUS = schema(
    "pi_queue_status",
    "Inspect one queued Pi task or list the global queue.",
    {"task_id": STRING},
)

TOOLS = {
    "pi_start": PI_START,
    "pi_send": PI_SEND,
    "pi_status": PI_STATUS,
    "pi_stop": PI_STOP,
    "pi_queue": PI_QUEUE,
    "pi_queue_status": PI_QUEUE_STATUS,
}
