#!/usr/bin/env bash
# Uptime Kuma (status checks + alerts) on the Pi, in Docker:  sudo bash uptime-kuma.sh
# Then open http://<pi-address>:3001 on your home network to set it up.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
TAG="${KUMA_TAG:-1}" # Uptime Kuma's stable release line

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

if docker ps -a --format '{{.Names}}' | grep -qx uptime-kuma; then
  docker pull "louislam/uptime-kuma:$TAG"
  docker rm -f uptime-kuma >/dev/null
fi
# host networking: Kuma can check the app at http://localhost:3000 directly.
docker run -d --name uptime-kuma --restart unless-stopped --network host \
  -v uptime-kuma:/app/data "louislam/uptime-kuma:$TAG" >/dev/null

echo "✓ Uptime Kuma is running: open http://$(hostname -I | awk '{print $1}'):3001"
