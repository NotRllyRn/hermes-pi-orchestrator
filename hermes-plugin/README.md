# Hermes Pi Orchestrator plugin

Persistent Pi coding sessions and a serialized global task queue for Hermes Agent.

## Install

From this repository checkout on the Hermes host:

```sh
scripts/install-hermes-plugin.sh
```

Restart the long-running Hermes gateway after install or update.

## Tools

- `pi_start` — start or reconnect the Pi session bound to the current Hermes conversation.
- `pi_send` — submit a prompt or steer/follow-up message.
- `pi_status` — inspect status, PID, latest result, and errors.
- `pi_stop` — stop the process while retaining its resumable session file.
- `pi_queue` — enqueue standalone work globally.
- `pi_queue_status` — inspect queue state and results.

Pi output is returned asynchronously through Hermes gateway message injection. The installer explicitly enables `plugins.entries.pi-orchestrator.allow_gateway_injection`; this permission is required for background completion messages. State uses atomic JSON files under `$HERMES_HOME/pi-orchestrator/`.

## Environment

```sh
# Optional: run Pi on Server C over key-authenticated SSH.
export PI_ORCHESTRATOR_PI_HOST='pi@server-c'
export PI_ORCHESTRATOR_PI_BIN='pi'
export PI_ORCHESTRATOR_REMOTE_SESSION_DIR='~/.hermes/pi-orchestrator/pi-sessions'

# Control API for the dashboard on Server B.
export PI_ORCHESTRATOR_API_BIND='0.0.0.0:8787'
export PI_ORCHESTRATOR_API_TOKEN='replace-with-a-long-random-token'
```

SSH uses `BatchMode=yes` and never prompts for credentials. Configure host keys and key-based login before starting Hermes. Keep the control API on a private network or firewall it to Server B.
