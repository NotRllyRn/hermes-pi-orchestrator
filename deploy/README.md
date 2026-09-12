# Server B → Server C deployment

## Topology

- **Server B:** Hermes Gateway plus `hermes-plugin/`.
- **Server C:** Pi, project checkouts, PI Dashboard, and `packages/orchestrator-plugin/`.
- **Transport:** persistent SSH local-forward from B to C. Dashboard stays on C loopback.

Machine A remains out of scope.

## 1. Prepare Server C

Install Pi and PI Dashboard. Authenticate Pi's model provider. Keep project checkouts under stable absolute roots.

Build and link this fork:

```sh
git clone git@github.com:NotRllyRn/hermes-pi-orchestrator.git
cd hermes-pi-orchestrator
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run link:local
```

In Dashboard settings, enable **Hermes Pi Orchestrator** and configure `allowedRoots`. Keep Dashboard bound to `127.0.0.1`.

Create Server C's protected environment file:

```sh
install -d -m 700 ~/.config/hermes-pi-orchestrator
cp deploy/dashboard.env.example ~/.config/hermes-pi-orchestrator/dashboard.env
chmod 600 ~/.config/hermes-pi-orchestrator/dashboard.env
```

Set `PI_ORCHESTRATOR_AUTH_SECRET` to a value from `openssl rand -hex 32`. Make the dashboard service inherit the file, then restart it.

## 2. Establish the B→C tunnel

From Server B, verify key-authenticated SSH and pin Server C's host key:

```sh
ssh -T -o BatchMode=yes -o ConnectTimeout=10 pi@server-c -- true
```

Run a persistent local forward. Replace C's port when Dashboard uses a non-default port:

```sh
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18000:127.0.0.1:8000 pi@server-c
```

Supervise this command with systemd or autossh. Restrict the SSH identity to the forwarding access it needs.

## 3. Install on Server B

```sh
git clone git@github.com:NotRllyRn/hermes-pi-orchestrator.git
cd hermes-pi-orchestrator
scripts/install-hermes-plugin.sh
```

Create Hermes' protected environment file:

```sh
install -d -m 700 ~/.config/hermes-pi-orchestrator
cp deploy/hermes.env.example ~/.config/hermes-pi-orchestrator/hermes.env
chmod 600 ~/.config/hermes-pi-orchestrator/hermes.env
```

Use the same `PI_ORCHESTRATOR_AUTH_SECRET` as Server C. Make the Hermes gateway service inherit the file, then restart it. For a systemd user service:

```ini
[Service]
EnvironmentFile=%h/.config/hermes-pi-orchestrator/hermes.env
```

The installer enables the plugin and gateway injection. The plugin stores policy state at `$HERMES_HOME/pi-orchestrator/state.db` with owner-only directory/database permissions.

## 4. Smoke test

On Server B:

```sh
curl -fsS http://127.0.0.1:18000/api/health
hermes plugins validate ~/.hermes/plugins/pi-orchestrator
hermes plugins list --enabled
```

In Hermes:

1. register a project;
2. submit work to its primary Pi session;
3. choose Queue, Steer, or Parallel on a later turn when prompted;
4. for a dirty tree, choose Wait or Committed HEAD on another later turn;
5. review a settled child before choosing merge, cherry-pick, or leave branch.

Open the Dashboard project's **Orchestrator** panel. Confirm worker state, cost, attention, review output, and explicit controls update.

## Security

- Never expose Dashboard's control plane publicly.
- Keep Dashboard on C loopback; use the restricted B→C SSH forward.
- Keep both environment files mode `0600`.
- Rotate `PI_ORCHESTRATOR_AUTH_SECRET` on B and C together.
- The shared secret gates one-time dirty-tree authorization only; Dashboard authentication and OS isolation remain separate controls.
- Give Pi's Server C account only required repository and credential access.
- Use a separate, explicitly approved break-glass SSH identity for diagnostics.
