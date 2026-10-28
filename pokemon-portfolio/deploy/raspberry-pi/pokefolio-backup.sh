#!/usr/bin/env bash
# Nightly backup of the PokéFolio database (Neon) to this Pi.
# Settings come from /etc/pokefolio/backup.env (via the pokefolio-backup systemd service).
set -euo pipefail

: "${BACKUP_DATABASE_URL:?Set BACKUP_DATABASE_URL in /etc/pokefolio/backup.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pokefolio}"
KEEP_DAYS="${KEEP_DAYS:-30}"
PING="${BACKUP_PING_URL:-}"

ping_kuma() { # status msg
  [ -n "$PING" ] || return 0
  local base="${PING%%\?*}"
  curl -fsS -m 15 -G "$base" --data-urlencode "status=$1" --data-urlencode "msg=$2" >/dev/null || true
}
mkdir -p "$BACKUP_DIR"
stamp="$(date +%F_%H%M)"
out="$BACKUP_DIR/pokefolio-$stamp.dump"
trap 'rm -f "$out.partial"; ping_kuma down "backup failed (line $LINENO) — see: journalctl -u pokefolio-backup"' ERR

# Custom format: compressed, and restorable table by table with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL" --file="$out.partial"
mv "$out.partial" "$out"
# Make sure the file is a complete, readable backup.
pg_restore --list "$out" >/dev/null

find "$BACKUP_DIR" -maxdepth 1 -name 'pokefolio-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'pokefolio-*.partial' -mmin +120 -delete

size="$(du -h "$out" | cut -f1)"
count="$(find "$BACKUP_DIR" -maxdepth 1 -name 'pokefolio-*.dump' | wc -l)"
echo "Backup OK: $out ($size) — $count backups kept"
ping_kuma up "OK $size, $count kept"
