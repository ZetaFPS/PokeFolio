#!/usr/bin/env bash
# PokéFolio on a Raspberry Pi — one-time setup (safe to run again).
#
#   git clone https://github.com/ZetaFPS/ClaudeSites.git
#   sudo bash ClaudeSites/pokemon-portfolio/deploy/raspberry-pi/install.sh
#
# Full step-by-step guide: README.md in this folder.
#
# Installs Node.js, the PostgreSQL client (for backups) and cloudflared; downloads the app to
# /opt/pokefolio/app; sets up the pokefolio service, the nightly backup and the firewall.
# It doesn't start the site — fill in /etc/pokefolio/pokefolio.env first (see the guide).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ZetaFPS/ClaudeSites.git}"
BRANCH="${BRANCH:-}"                       # empty = the repository's default branch
HOME_DIR=/opt/pokefolio
APP_ROOT="$HOME_DIR/app"                   # the git checkout
APP_DIR="$APP_ROOT/pokemon-portfolio"      # the app inside it
CONF=/etc/pokefolio

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash install.sh"
[ "$(uname -m)" = "aarch64" ] || die "This needs the 64-bit Raspberry Pi OS (found $(uname -m)). Re-flash the card with 'Raspberry Pi OS Lite (64-bit)'."
. /etc/os-release
CODENAME="${VERSION_CODENAME:-bookworm}"

say "Updating the system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl ca-certificates gnupg ufw unattended-upgrades

say "Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v)"

say "PostgreSQL client (pg_dump for backups)"
# Debian's own client can be older than Neon's server; the PostgreSQL project's repo has the newest.
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update -y
apt-get install -y postgresql-client
pg_dump --version

say "cloudflared (Cloudflare Tunnel)"
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt-get update -y
apt-get install -y cloudflared
cloudflared --version

say "App user and folders"
id pokefolio >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin pokefolio
install -d -o pokefolio -g pokefolio "$HOME_DIR" /var/backups/pokefolio
install -d -m 0750 -o root -g pokefolio "$CONF"

say "Downloading PokéFolio"
as_app() { sudo -u pokefolio -H "$@"; }
if [ -d "$APP_ROOT/.git" ]; then
  as_app git -C "$APP_ROOT" pull --ff-only
else
  # A private repository asks for your GitHub username and a token (see the guide); it's then
  # remembered for updates, readable only by the pokefolio user.
  as_app git config --global credential.helper store
  as_app git clone ${BRANCH:+--branch "$BRANCH"} "$REPO_URL" "$APP_ROOT"
fi
[ -f "$APP_DIR/server.js" ] || die "Couldn't find the app at $APP_DIR"

say "Installing the app's packages"
(cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund)

say "Settings files"
SRC="$APP_DIR/deploy/raspberry-pi"
[ -f "$CONF/pokefolio.env" ] || install -m 0640 -o root -g pokefolio "$SRC/pokefolio.env.example" "$CONF/pokefolio.env"
[ -f "$CONF/backup.env" ] || install -m 0640 -o root -g pokefolio "$SRC/backup.env.example" "$CONF/backup.env"

say "Services"
install -m 0755 "$SRC/pokefolio-backup.sh" /usr/local/bin/pokefolio-backup
install -m 0755 "$SRC/update.sh" /usr/local/bin/pokefolio-update
install -m 0644 "$SRC/pokefolio.service" "$SRC/pokefolio-backup.service" "$SRC/pokefolio-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable pokefolio.service pokefolio-backup.timer >/dev/null
systemctl start pokefolio-backup.timer

say "Firewall (SSH from anywhere on your network; the site itself goes out through the tunnel)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do
  ufw allow from "$net" to any port 3000 proto tcp >/dev/null   # the app, for testing on your Wi-Fi
  ufw allow from "$net" to any port 3001 proto tcp >/dev/null   # Uptime Kuma
done
ufw --force enable >/dev/null
ufw status | head -3

say "Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

IP="$(hostname -I | awk '{print $1}')"
cat <<MSG

✓ Installed. Next (details in $SRC/README.md):
  1. sudo nano $CONF/pokefolio.env      ← paste DATABASE_URL and your other Render settings
  2. sudo systemctl restart pokefolio  &&  curl -s localhost:3000/api/health?db=1
     then open http://$IP:3000 on a phone or computer on the same Wi-Fi
  3. Cloudflare Tunnel:  sudo cloudflared service install <your-token>
  4. sudo nano $CONF/backup.env         ← Neon's direct connection string
     then test:  sudo systemctl start pokefolio-backup && journalctl -u pokefolio-backup -n 5
  5. Uptime monitoring:  sudo bash $SRC/uptime-kuma.sh
MSG
