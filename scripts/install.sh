#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/panel}"
DOMAIN="${PANEL_DOMAIN:-panel.timptr.ru}"
PORT="${PANEL_PORT:-7777}"
CONF_NAME="${PANEL_NGINX_CONF:-panel.timptr.ru.conf}"
ENV_FILE="${APP_DIR}/.env"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install.sh" >&2
  exit 1
fi

cd "$APP_DIR"

for command in docker nginx certbot; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$key" '
    $1 == key {
      sub(/^[^=]*=/, "")
      if ($0 ~ /^'\''.*'\''$/ || $0 ~ /^".*"$/) {
        print substr($0, 2, length($0) - 2)
      } else {
        print
      }
      exit
    }
  ' "$ENV_FILE"
}

base64_encode() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

sanitize_env_file() {
  [[ -f "$ENV_FILE" ]] || return 0

  local tmp_file
  tmp_file="$(mktemp)"

  awk -F= '
    /^[[:space:]]*$/ { print; next }
    /^[[:space:]]*#/ { print; next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key = $1
      sub(/^[^=]*=/, "")
      if ($0 ~ /^'\''.*'\''$/ || $0 ~ /^".*"$/) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print key "=" $0
      next
    }
    {
      printf "Dropping invalid .env line: %s\n", $0 > "/dev/stderr"
    }
  ' "$ENV_FILE" >"$tmp_file"

  install -m 600 "$tmp_file" "$ENV_FILE"
  rm -f "$tmp_file"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local tmp_file

  tmp_file="$(mktemp)"
  if [[ -f "$ENV_FILE" ]] && awk -F= -v key="$key" '$1 == key { found = 1 } END { exit(found ? 0 : 1) }' "$ENV_FILE"; then
    awk -F= -v key="$key" -v value="$value" 'BEGIN { written = 0 } $1 == key && !written { print key "=" value; written = 1; next } { print }' "$ENV_FILE" >"$tmp_file"
  else
    [[ -f "$ENV_FILE" ]] && cp "$ENV_FILE" "$tmp_file"
    printf '%s=%s\n' "$key" "$value" >>"$tmp_file"
  fi

  install -m 600 "$tmp_file" "$ENV_FILE"
  rm -f "$tmp_file"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64
    echo
  fi
}

prompt_password() {
  local password=""
  local confirmation=""

  if [[ ! -t 0 ]]; then
    echo "PANEL_PASSWORD is missing and no interactive terminal is available." >&2
    echo "Run interactively or pass PANEL_PASSWORD=... sudo -E bash scripts/install.sh" >&2
    exit 1
  fi

  while true; do
    read -rsp "Set panel master password: " password
    echo >&2
    read -rsp "Repeat panel master password: " confirmation
    echo >&2

    if [[ -z "$password" ]]; then
      echo "Password cannot be empty." >&2
    elif [[ "$password" != "$confirmation" ]]; then
      echo "Passwords do not match." >&2
    else
      printf '%s' "$password"
      return
    fi
  done
}

prepare_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$APP_DIR/.env.example" ]]; then
      install -m 600 "$APP_DIR/.env.example" "$ENV_FILE"
    else
      install -m 600 /dev/null "$ENV_FILE"
    fi
  else
    chmod 600 "$ENV_FILE"
  fi
  sanitize_env_file

  local current_password
  local current_password_b64
  current_password="$(read_env_value PANEL_PASSWORD)"
  current_password_b64="$(read_env_value PANEL_PASSWORD_B64)"
  if [[ -n "${PANEL_PASSWORD:-}" ]]; then
    write_env_value PANEL_PASSWORD_B64 "$(base64_encode "$PANEL_PASSWORD")"
    write_env_value PANEL_PASSWORD ""
  elif [[ -z "$current_password_b64" && ( -z "$current_password" || "$current_password" == "change-me" ) ]]; then
    write_env_value PANEL_PASSWORD_B64 "$(base64_encode "$(prompt_password)")"
    write_env_value PANEL_PASSWORD ""
  fi

  local current_secret
  current_secret="$(read_env_value SESSION_SECRET)"
  if [[ -n "${SESSION_SECRET:-}" ]]; then
    write_env_value SESSION_SECRET "$SESSION_SECRET"
  elif [[ -z "$current_secret" || "$current_secret" == "replace-with-random-long-secret" ]]; then
    write_env_value SESSION_SECRET "$(generate_secret)"
  fi

  [[ -n "$(read_env_value PORT)" ]] || write_env_value PORT "$PORT"

  local current_cookie_secure
  current_cookie_secure="$(read_env_value COOKIE_SECURE)"
  if [[ -n "${COOKIE_SECURE:-}" ]]; then
    write_env_value COOKIE_SECURE "$COOKIE_SECURE"
  elif [[ -z "$current_cookie_secure" ]]; then
    write_env_value COOKIE_SECURE "false"
  elif [[ "$current_cookie_secure" == "true" && ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
    write_env_value COOKIE_SECURE "false"
  fi

  [[ -n "$(read_env_value NGINX_MANAGED_PREFIX)" ]] || write_env_value NGINX_MANAGED_PREFIX "panel-managed-"
  [[ -n "$(read_env_value ALLOW_ANY_DOMAIN)" ]] || write_env_value ALLOW_ANY_DOMAIN "false"
  write_env_value PANEL_VERSION "$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo dev)"
  write_env_value PANEL_BUILD "$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
}

show_panel_diagnostics() {
  echo "Panel did not become available on 127.0.0.1:${PORT}." >&2
  echo "Docker Compose status:" >&2
  docker compose ps >&2 || true
  echo "Panel container logs:" >&2
  docker logs --tail=120 panel >&2 || true
  echo "Listening ports that mention ${PORT}:" >&2
  ss -ltnp 2>/dev/null | grep ":${PORT}" >&2 || true
}

wait_for_panel() {
  local attempts=30
  local attempt

  for attempt in $(seq 1 "$attempts"); do
    if timeout 1 bash -c ":</dev/tcp/127.0.0.1/${PORT}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  show_panel_diagnostics
  exit 1
}

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required: docker compose" >&2
  exit 1
fi

prepare_env
docker compose up -d --build
wait_for_panel

cat >/etc/nginx/sites-available/"$CONF_NAME" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/"$CONF_NAME" /etc/nginx/sites-enabled/"$CONF_NAME"
nginx -t
systemctl reload nginx

echo "Panel container is running on localhost:${PORT}"
echo "Open http://${DOMAIN} and issue HTTPS certificate from the panel or run:"
echo "certbot --nginx -d ${DOMAIN} -m YOUR_EMAIL --agree-tos --non-interactive --redirect"
