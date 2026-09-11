# Three-server deployment

## Topology

- **Server A:** Hermes Agent gateway and this Hermes plugin.
- **Server B:** this pi-dashboard fork and orchestrator dashboard plugin.
- **Server C:** Pi coding agent and project worktrees.

Server A reaches Server C over key-authenticated SSH. Server B reaches Server A's token-authenticated HTTP control API. Pi and dashboard state never share a filesystem.

## 1. Prepare Server C

Install Pi and authenticate its model provider as the account that SSH will use. Put project checkouts at stable absolute paths.

From Server A, establish and verify the host key once, then verify non-interactive access:

```sh
ssh pi@server-c 'pi --version'
ssh -T -o BatchMode=yes -o ConnectTimeout=10 pi@server-c -- sh -lc 'cd /path/to/project && pi --version'
```

The plugin deliberately uses `BatchMode=yes`; password and host-key prompts fail instead of hanging Hermes.

## 2. Install on Server A

```sh
git clone git@github.com:NotRllyRn/hermes-pi-orchestrator.git
cd hermes-pi-orchestrator
scripts/install-hermes-plugin.sh
```

The installer validates and enables the plugin, then opts it into Hermes gateway message injection so asynchronous Pi completions can trigger a follow-up Hermes turn.

Generate a shared control-plane token and create an environment file from [`hermes.env.example`](hermes.env.example):

```sh
install -d -m 700 ~/.config/hermes-pi-orchestrator
cp deploy/hermes.env.example ~/.config/hermes-pi-orchestrator/hermes.env
chmod 600 ~/.config/hermes-pi-orchestrator/hermes.env
openssl rand -hex 32
```

Replace host names, paths, and token. Make the Hermes gateway service inherit that file, then restart it. For systemd user services:

```ini
[Service]
EnvironmentFile=%h/.config/hermes-pi-orchestrator/hermes.env
```

Use `systemctl --user edit <your-hermes-service>` to add the drop-in. Restrict TCP 8787 so only Server B can connect.

## 3. Install on Server B

```sh
git clone git@github.com:NotRllyRn/hermes-pi-orchestrator.git
cd hermes-pi-orchestrator
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run link:local
```

Create a protected environment file from [`dashboard.env.example`](dashboard.env.example), using the same token:

```sh
install -d -m 700 ~/.config/hermes-pi-orchestrator
cp deploy/dashboard.env.example ~/.config/hermes-pi-orchestrator/dashboard.env
chmod 600 ~/.config/hermes-pi-orchestrator/dashboard.env
```

Make the dashboard service inherit this file and restart `pi-dashboard`. Open **Settings → General → Hermes Pi Orchestrator**.

## 4. Smoke test

On Server A:

```sh
curl -fsS -H "Authorization: Bearer $PI_ORCHESTRATOR_API_TOKEN" \
  http://127.0.0.1:8787/health
hermes plugins validate ~/.hermes/plugins/pi-orchestrator
hermes plugins list --enabled
```

On Server B:

```sh
curl -fsS -H "Authorization: Bearer $HERMES_ORCHESTRATOR_TOKEN" \
  "$HERMES_ORCHESTRATOR_URL/sessions"
pi-dashboard status
```

In a Hermes conversation, ask Hermes to call `pi_start`, then `pi_send`. Verify the dashboard shows the session as busy, later idle, and displays the result. Restart Hermes and send another task; Pi resumes from the persisted session JSONL.

## Security

- Never expose port 8787 publicly.
- Use a private network, firewall allowlist, or SSH tunnel between Servers A and B.
- Keep both environment files mode `0600`.
- Rotate the token on both servers together.
- Give Server A's SSH key only the Server C permissions and repository access Pi needs.
- Review plugin updates before rerunning the installer.
