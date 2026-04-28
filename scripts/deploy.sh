#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration via environment variables (all have sensible defaults)
# ---------------------------------------------------------------------------
REPO_DIR="${REPO_DIR:-/opt/panel}"
IMAGE_NAME="${IMAGE_NAME:-panel}"
CONTAINER_NAME="${CONTAINER_NAME:-panel}"
HOST_PORT="${HOST_PORT:-7777}"
CONTAINER_PORT="${CONTAINER_PORT:-7777}"
DATA_VOLUME="${DATA_VOLUME:-${CONTAINER_NAME}_data}"
CONFIG_HOST="${CONFIG_HOST:-}"
CONFIG_CONTAINER="${CONFIG_CONTAINER:-/app/config.json}"
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-/api/healthz}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"

# ---------------------------------------------------------------------------
# Application env vars forwarded into the container (-e flags).
# Add any KEY=VALUE pairs you need; they are passed through as-is.
# ---------------------------------------------------------------------------
APP_ENV_VARS=(
  "PORT=${CONTAINER_PORT}"
  "NODE_ENV=${NODE_ENV:-production}"
)

# Collect every PANEL_* / SESSION_* / COOKIE_* / TRUST_* variable from the
# current environment so operators can pass secrets without editing this file.
while IFS='=' read -r key value; do
  APP_ENV_VARS+=("${key}=${value}")
done < <(env | grep -E '^(PANEL_|SESSION_|COOKIE_|TRUST_|NGINX_|ALLOW_|CERTBOT_|HOST_ROOT=)' || true)

# ---------------------------------------------------------------------------
echo ">>> Updating repository in ${REPO_DIR}"
# ---------------------------------------------------------------------------
cd "${REPO_DIR}"
git fetch origin main
git checkout main
git pull --ff-only origin main

# ---------------------------------------------------------------------------
echo ">>> Determining build ID"
# ---------------------------------------------------------------------------
BUILD_ID="${BUILD_ID:-$(git rev-parse --short HEAD)}"
echo "    BUILD_ID=${BUILD_ID}"

# ---------------------------------------------------------------------------
echo ">>> Building Docker image: ${IMAGE_NAME} (build ${BUILD_ID})"
# ---------------------------------------------------------------------------
docker build \
  -t "${IMAGE_NAME}" \
  --build-arg BUILD_ID="${BUILD_ID}" \
  .

# ---------------------------------------------------------------------------
echo ">>> Removing old container: ${CONTAINER_NAME}"
# ---------------------------------------------------------------------------
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

# ---------------------------------------------------------------------------
echo ">>> Starting new container: ${CONTAINER_NAME}"
# ---------------------------------------------------------------------------
RUN_ARGS=(
  --detach
  --name "${CONTAINER_NAME}"
  --restart unless-stopped
  -p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}"
  -v "${DATA_VOLUME}:/app/data"
)

for env_pair in "${APP_ENV_VARS[@]}"; do
  RUN_ARGS+=(-e "${env_pair}")
done

if [[ -n "${CONFIG_HOST}" && -f "${CONFIG_HOST}" ]]; then
  echo "    Mounting config: ${CONFIG_HOST} -> ${CONFIG_CONTAINER}"
  RUN_ARGS+=(-v "${CONFIG_HOST}:${CONFIG_CONTAINER}:ro")
fi

docker run "${RUN_ARGS[@]}" "${IMAGE_NAME}"

# ---------------------------------------------------------------------------
echo ">>> Health check: http://127.0.0.1:${HOST_PORT}${HEALTH_ENDPOINT}"
# ---------------------------------------------------------------------------
healthy=false
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -sfS "http://127.0.0.1:${HOST_PORT}${HEALTH_ENDPOINT}" >/dev/null 2>&1; then
    healthy=true
    echo "    Attempt ${i}/${HEALTH_RETRIES}: OK"
    break
  fi
  echo "    Attempt ${i}/${HEALTH_RETRIES}: waiting…"
  sleep 1
done

if [[ "${healthy}" != "true" ]]; then
  echo ">>> HEALTH CHECK FAILED after ${HEALTH_RETRIES} attempts" >&2
  echo ">>> Last ${CONTAINER_NAME} logs:" >&2
  docker logs --tail=80 "${CONTAINER_NAME}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
echo ">>> Deploy complete: ${IMAGE_NAME}@${BUILD_ID} → ${CONTAINER_NAME} on port ${HOST_PORT}"
# ---------------------------------------------------------------------------
