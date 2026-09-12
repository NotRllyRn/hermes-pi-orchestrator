# Hermes Pi Orchestrator plugin

Human-gated supervision of persistent Pi sessions owned by PI Dashboard on Server C. The plugin runs on Hermes Server B as a headless Dashboard browser client. It never launches `pi --mode rpc`, owns Pi processes, or copies Pi transcripts.

## Install

```sh
scripts/install-hermes-plugin.sh
```

The installer enables the plugin and `plugins.entries.pi-orchestrator.allow_gateway_injection`. Restart the long-running Hermes gateway after install or update.

## Tools

- `pi_projects`, `pi_project_status` — compact live project/session/usage state.
- `pi_project_register` — canonicalize a Server C repository and bind one existing session.
- `pi_task_submit` — submit serial work or create a side-effect-free busy decision.
- `pi_task_resolve` — execute Queue, Steer, or Parallel only after explicit later-turn evidence.
- `pi_parallel_resolve` — on a dirty primary tree, require another later choice between waiting and committed `HEAD`.
- `pi_task_abort`, `pi_worker_send` — known-worker controls.
- `pi_recent_activity`, `pi_diagnostics` — bounded observability.

Queue maps to Dashboard `delivery: "followUp"`; Steer maps to `delivery: "steer"`. Raw `pre_llm_call` input, project state version, decision TTL, and `pre_tool_call` enforce the mandatory human choice independently of model intent.

## Environment

```sh
# Local end of Server B's independently supervised SSH tunnel to Server C.
export PI_DASHBOARD_URL='http://127.0.0.1:18000'
export PI_ORCHESTRATOR_AUTH_SECRET='<same random secret configured on Server C>'
```

`PI_ORCHESTRATOR_AUTH_SECRET` authenticates Hermes-only parallel authorization, spawn, and child integration requests. Send it only through the B→C SSH tunnel.

State lives in `$HERMES_HOME/pi-orchestrator/state.db` with SQLite WAL and owner-only permissions. Pi JSONL remains authoritative on Server C. Browser replay sequence cursors prevent duplicate activity and notifications after reconnect.
