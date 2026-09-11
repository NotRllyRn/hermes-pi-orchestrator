# DOX — hermes-plugin/pi_orchestrator

| File | Purpose |
| ------ | --------- |
| `__init__.py` | Python package marker. |
| `api.py` | Token-authenticated HTTP control API for dashboard monitoring and control. |
| `queue.py` | Single-worker durable priority queue for standalone Pi tasks. |
| `rpc.py` | Local or SSH Pi RPC subprocess manager with JSONL event correlation and persistence. |
| `runtime.py` | Hermes tool handlers, notifications, lifecycle reconciliation, and capability registration. |
| `schemas.py` | OpenAI function schemas for the six Hermes orchestration tools. |
| `state.py` | Atomic JSON persistence and session/task data models. |
