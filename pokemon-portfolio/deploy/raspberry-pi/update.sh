#!/usr/bin/env bash
# Update PokéFolio on the Pi to the latest code:  sudo pokefolio-update
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo pokefolio-update" >&2; exit 1; }
APP_ROOT=/opt/pokefolio/app
APP_DIR="$APP_ROOT/pokemon-portfolio"
as_app() { sudo -u pokefolio -H "$@"; }

before="$(as_app git -C "$APP_ROOT" rev-parse --short HEAD)"
as_app git -C "$APP_ROOT" pull --ff-only
after="$(as_app git -C "$APP_ROOT" rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then echo "Already up to date ($after)."; exit 0; fi

(cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund)
# Keep the installed helper scripts and services in step with the repository.
SRC="$APP_DIR/deploy/raspberry-pi"
install -m 0755 "$SRC/pokefolio-backup.sh" /usr/local/bin/pokefolio-backup
install -m 0755 "$SRC/update.sh" /usr/local/bin/pokefolio-update
install -m 0644 "$SRC/pokefolio.service" "$SRC/pokefolio-backup.service" "$SRC/pokefolio-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl restart pokefolio
sleep 4
systemctl --no-pager --lines=0 status pokefolio | head -3
curl -fsS localhost:3000/api/health?db=1 && echo && echo "Updated $before → $after ✓"
