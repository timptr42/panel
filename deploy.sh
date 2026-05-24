#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

cd "$APP_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repository: $APP_DIR" >&2
  exit 1
fi

echo "[deploy] Fetching origin/${DEPLOY_BRANCH}"
git fetch origin "$DEPLOY_BRANCH"

echo "[deploy] Updating local ${DEPLOY_BRANCH}"
git checkout "$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH"

echo "[deploy] Running install script"
if [[ $EUID -eq 0 ]]; then
  bash scripts/install.sh
elif command -v sudo >/dev/null 2>&1; then
  sudo -E bash scripts/install.sh
else
  echo "Run as root or install sudo to execute scripts/install.sh" >&2
  exit 1
fi

echo "[deploy] Done"
