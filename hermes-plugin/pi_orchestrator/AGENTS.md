# DOX — hermes-plugin/pi_orchestrator

| File | Purpose |
| ------ | --------- |
| `__init__.py` | Python package marker. |
| `choice_parser.py` | Strict parsers for concurrency, dirty-tree, approval, and integration evidence. |
| `notifications.py` | Durable route-bound Hermes notification worker with persisted bounded retry. |
| `reducer.py` | Deterministic compact projection of Dashboard sessions and significant Pi events. |
| `runtime.py` | Hermes tools, raw-turn policy hooks, connection startup, and unload cleanup. |
| `schemas.py` | Model-facing schemas for project, task, activity, and bounded diagnostics tools. |
| `service.py` | Human-gated orchestration, authenticated dirty preflight, parallel review/integration, and project policy. |
| `store.py` | Owner-only SQLite project/task/decision/preflight/cursor/activity/notification state and migrations. |
