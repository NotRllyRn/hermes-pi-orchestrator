# Upstream

## Baseline

- Repository: <https://github.com/BlackBeltTechnology/pi-agent-dashboard>
- Release: `v0.8.0`
- Commit: `04985091706cb77d5e2f73bbf8b906966e9d97c7`
- Pinned: 2026-09-11

Production starts from this reviewed release. `develop` remains unpinned development input.

## Remotes

```text
origin   ssh://git@github.com/NotRllyRn/hermes-pi-orchestrator.git
upstream ssh://git@github.com/BlackBeltTechnology/pi-agent-dashboard.git
```

## Local patches

None.

## Sync

```bash
git fetch upstream --tags
git switch -c chore/upstream-sync-YYYY-MM-DD main
git merge upstream/develop
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
```

Run orchestrator contract, security, and extension compatibility tests before merging. Update this file with tested Dashboard, Pi, Hermes, and extension versions. Deploy only an exact reviewed commit.
