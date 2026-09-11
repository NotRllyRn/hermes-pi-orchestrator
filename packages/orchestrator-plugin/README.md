# Hermes orchestration plugin for PI Dashboard

Minimal Server C extension used by the Hermes headless Dashboard client. PI Dashboard remains the only Pi session/process/event hub.

The plugin currently provides:

- canonical project inspection under configured workspace roots;
- matching Dashboard sessions for primary binding;
- bounded, secret-redacted event diagnostics;
- server-side foundations for atomic worktree + forked-session transactions.

Configure `plugins.hermes-pi-orchestrator.allowedRoots` in PI Dashboard settings before project registration. Keep Dashboard bound to loopback and expose it to Server B only through the dedicated SSH local-forward tunnel.

No browser UI or separate Pi process manager is included. Hermes uses Dashboard's existing browser WebSocket protocol for snapshots, replay, `followUp`, `steer`, spawn/resume, abort, and live events.
