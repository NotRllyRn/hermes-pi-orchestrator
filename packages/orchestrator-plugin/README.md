# Hermes orchestration plugin for PI Dashboard

Dashboard server, bridge, and browser surfaces for Hermes-controlled Pi orchestration.

## Provides

- canonical project inspection under configured workspace roots;
- primary-session binding by canonical repository root;
- bounded, secret-redacted diagnostics;
- atomic Git worktree plus forked-session transactions;
- settled-child review packages and explicit integration routes;
- project overview, folder status, queue/steer, review, and abort UI;
- Pi-native queue/steer delivery and durable integration annotations.

Parallel spawn and child integration routes require `PI_ORCHESTRATOR_AUTH_SECRET`. Browser UI cannot call them. Hermes must obtain the user's explicit policy choice before invoking either route.

Configure `plugins.hermes-pi-orchestrator.allowedRoots` in PI Dashboard settings before project registration. Keep Dashboard bound to loopback. Connect Hermes through a dedicated SSH local-forward tunnel.
