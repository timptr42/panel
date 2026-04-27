#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/panel}"
DOMAIN="${PANEL_DOMAIN:-panel.timptr.ru}"
PORT="${PANEL_PORT:-7777}"
CONF_NAME="${PANEL_NGINX_CONF:-panel.timptr.ru.conf}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install.sh" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "$APP_DIR/.env was not found. Copy .env.example to .env and set PANEL_PASSWORD first." >&2
  exit 1
fi

cd "$APP_DIR"

for command in docker nginx certbot; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required: docker compose" >&2
  exit 1
fi

docker compose up -d --build

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
