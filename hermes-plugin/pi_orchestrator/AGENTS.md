# DOX — hermes-plugin/pi_orchestrator

| File | Purpose |
| ------ | --------- |
| `__init__.py` | Python package marker. |
| `choice_parser.py` | Strict single-choice parser for later-turn Queue/Steer/Parallel evidence. |
| `notifications.py` | Durable asynchronous Hermes gateway notification worker. |
| `reducer.py` | Deterministic compact projection of Dashboard sessions and significant Pi events. |
| `runtime.py` | Hermes tools, raw-turn policy hooks, connection startup, and unload cleanup. |
| `schemas.py` | Model-facing schemas for project, task, activity, and bounded diagnostics tools. |
| `service.py` | Human-gated orchestration policy over Dashboard browser and REST operations. |
| `store.py` | SQLite project/task/decision/route/cursor/activity/notification state. |
