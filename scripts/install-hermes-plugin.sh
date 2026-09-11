#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$repo_root/hermes-plugin"
hermes_home=${HERMES_HOME:-"$HOME/.hermes"}
target=${1:-"$hermes_home/plugins/pi-orchestrator"}
plugins_dir=$(dirname "$target")

mkdir -p "$plugins_dir"
tmp=$(mktemp -d "$plugins_dir/.pi-orchestrator.XXXXXX")
backup=""
cleanup() {
  rm -rf "$tmp"
  if [[ -n "$backup" && -e "$backup" && ! -e "$target" ]]; then
    mv "$backup" "$target"
  fi
}
trap cleanup EXIT

cp "$source_dir/__init__.py" "$source_dir/plugin.yaml" "$source_dir/pyproject.toml" "$source_dir/README.md" "$tmp/"
cp -R "$source_dir/pi_orchestrator" "$tmp/"
find "$tmp" -type d -name __pycache__ -prune -exec rm -rf {} +

python3 -m compileall -q "$tmp"
find "$tmp" -type d -name __pycache__ -prune -exec rm -rf {} +

if command -v hermes >/dev/null 2>&1; then
  PI_ORCHESTRATOR_API_BIND=off hermes plugins validate "$tmp"
fi

if [[ -e "$target" ]]; then
  backup="$target.backup.$$"
  mv "$target" "$backup"
fi
mv "$tmp" "$target"
if [[ -n "$backup" ]]; then
  rm -rf "$backup"
  backup=""
fi

if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable pi-orchestrator
  hermes config set plugins.entries.pi-orchestrator.allow_gateway_injection true --force
else
  printf '%s\n' "Hermes executable not found; enable 'pi-orchestrator' after Hermes is installed."
fi

printf '%s\n' "Installed Hermes Pi Orchestrator at $target"
printf '%s\n' "Restart the Hermes gateway to load the plugin."
