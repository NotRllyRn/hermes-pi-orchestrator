# Hermes Pi Orchestrator dashboard plugin

A pi-dashboard plugin that monitors and controls Pi sessions and queued coding tasks owned by the Hermes plugin.

The panel appears in **Settings → General → Hermes Pi Orchestrator**. It shows connection state, process status and PID, model, working directory, latest result, and queued task state. Operators can send follow-ups, resume or stop sessions, enqueue tasks, and cancel queued work.

## Server configuration

The browser never receives the orchestrator token. The dashboard server proxies all requests to the authenticated control API on the Hermes host.

On Server A (Hermes), configure:

```sh
export PI_ORCHESTRATOR_API_BIND=0.0.0.0:8787
export PI_ORCHESTRATOR_API_TOKEN='replace-with-a-long-random-token'
```

On Server B (pi-dashboard), configure:

```sh
export HERMES_ORCHESTRATOR_URL='http://server-a:8787'
export HERMES_ORCHESTRATOR_TOKEN='replace-with-the-same-token'
```

Keep port 8787 restricted to Server B with a firewall, private network, or SSH tunnel. A non-loopback Hermes API bind is rejected unless a token is configured.
