# Running PokéFolio on a Raspberry Pi

This runs the PokéFolio website on your Raspberry Pi 4, while your accounts and cards stay in your
**Neon** database (exactly where they are now). The Pi also:

- **backs up the Neon database every night** (keeps the last 30 days), and
- runs **Uptime Kuma**, which checks the site every minute and alerts you if it goes down.

Visitors reach the Pi through a free **Cloudflare Tunnel**: no ports are opened on your router, and
your home IP address stays private. Later, when your server build with the SSD is ready, the
database can move onto it too, and everything here stays the same.

**Time needed:** about 1–1½ hours the first time.

---

## What you need

- Raspberry Pi 4 (2 GB works; 4 GB+ is comfortable), its **official** USB-C power supply.
- A **microSD card**, 32–64 GB. A "High Endurance" card (SanDisk High Endurance, Samsung PRO
  Endurance) lasts much longer in an always-on device.
- An **Ethernet cable** to your router. Use a cable, not Wi-Fi, for a server.
- A computer to set it up from (Windows, Mac or Linux).
- A **domain name on Cloudflare** (e.g. `pokefolio.com`, ~$10/year). Have one elsewhere? You can
  move its DNS to Cloudflare for free (step 6 explains).
- Optional: a **USB stick** (16 GB+) to hold the nightly backups.

Keep these open in browser tabs: your **Render** dashboard (to copy settings), **Neon**
console, **Cloudflare** dashboard, and **Stripe** dashboard (only if you use Premium).

---

## Step 1 — Put Raspberry Pi OS on the SD card (on your computer)

1. Install **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/> and open it.
2. **Choose Device:** Raspberry Pi 4.
3. **Choose OS:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.
   (It must be the **64-bit Lite** one: no desktop needed, and the app requires 64-bit.)
4. **Choose Storage:** your microSD card.
5. Click **Next** → **Edit Settings** and fill in:
   - **General:** hostname `pokefolio`; a username (e.g. `pi`) and a strong password; your
     **time zone** (backups run at 3:30 am in it). Skip "Configure wireless LAN".
   - **Services:** tick **Enable SSH** → *Use password authentication*.
6. **Save** → **Yes** → **Yes**. Wait for it to write and verify, then remove the card.

## Step 2 — Start the Pi and connect to it

1. Put the card in the Pi, plug in the **Ethernet cable**, then the power. Wait **2 minutes**.
2. On your computer open a terminal (Windows: **PowerShell**; Mac: **Terminal**) and type
   (with your username from step 1):
   ```
   ssh pi@pokefolio.local
   ```
   Type `yes` when asked about the fingerprint, then your password.
   *If `pokefolio.local` isn't found:* look up the Pi's IP address in your router's list of
   connected devices and use `ssh pi@192.168.x.x` instead.

Everything below in `grey boxes` is typed **into this SSH window** (the Pi), unless it says otherwise.

## Step 3 — Install PokéFolio (one command does almost everything)

1. Download the code:
   ```
   sudo apt update && sudo apt install -y git
   git clone https://github.com/ZetaFPS/ClaudeSites.git
   ```
   **If your GitHub repository is private**, git asks for a username and password. Enter your
   GitHub **username**, and for the password paste a **token** (a password won't work):
   GitHub → your picture → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token** → name `raspberry-pi`, expiration 1 year,
   **Repository access:** *Only select repositories* → `ClaudeSites`, **Permissions →
   Repository permissions → Contents: Read-only** → **Generate**, and copy it. Keep it somewhere
   safe: the installer asks for it once more.
2. Run the installer (takes 5–15 minutes):
   ```
   sudo bash ClaudeSites/pokemon-portfolio/deploy/raspberry-pi/install.sh
   ```
   It updates the Pi, installs Node.js, the PostgreSQL tools (for backups) and Cloudflare's
   tunnel program, downloads the app to `/opt/pokefolio`, and sets up the service, the nightly
   backup, a firewall and automatic security updates. (Private repo: it asks for the username
   and token again, for its own copy that it updates from later.)
   It ends with **✓ Installed** and a short list of next steps.

## Step 4 — Give it your settings (from Render and Neon)

1. Open the settings file:
   ```
   sudo nano /etc/pokefolio/pokefolio.env
   ```
2. In **Render** → your service → **Environment**, copy each value into the matching line:
   - `DATABASE_URL` — **required.** The same Neon connection string Render uses.
     (Or get it from **Neon** → your project → **Dashboard** → **Connect** → copy the
     connection string. Either the pooled or the direct one works for the app.)
   - `ADMIN_EMAILS` — **required** for your admin panel.
   - Any others you use: `PRICECHARTING_TOKEN`, `POKEMONTCG_API_KEY`, the three `STRIPE_…` and the
     three `TWILIO_…` settings. Leave a line empty if you don't use it.
   - Leave `NODE_ENV`, `PORT` and `TRUST_PROXY` as they are.
3. Save and exit nano: **Ctrl + O**, **Enter**, **Ctrl + X**.
4. Start the site and check it:
   ```
   sudo systemctl restart pokefolio
   sleep 10; curl -s "localhost:3000/api/health?db=1"
   ```
   You should see `{"ok":true,"database":"ok",…}`.
   - `DATABASE_URL is empty` or `database: unreachable`? Check the connection string (it starts
     with `postgresql://` and ends with `?sslmode=require`), fix it, restart again.
   - See what the app is doing: `journalctl -u pokefolio -n 50`
5. On a phone or computer **on the same Wi-Fi**, open `http://pokefolio.local:3000`
   (or `http://<the Pi's IP>:3000`). You should see PokéFolio with your real accounts.
   *(Signing in over this plain `http://` address is just for this test; the real address in
   step 6 is `https://`.)*

## Step 5 — Nightly backups of Neon

Backups need Neon's **direct** connection string (the pooled one can't make backups):

1. **Neon** → your project → **Dashboard** → **Connect**. Turn **Connection pooling OFF**, click
   **Show password**, and copy the string. (Its host name does **not** contain `-pooler`.)
2. On the Pi:
   ```
   sudo nano /etc/pokefolio/backup.env
   ```
   Paste it after `BACKUP_DATABASE_URL=`, save and exit (**Ctrl + O**, **Enter**, **Ctrl + X**).
3. Run a backup now to test it:
   ```
   sudo systemctl start pokefolio-backup
   journalctl -u pokefolio-backup -n 5 --no-pager
   ```
   You should see `Backup OK: /var/backups/pokefolio/pokefolio-….dump`. From now on it runs every
   night at about 3:30 (and right after the Pi starts, if it was off at that time).

**Recommended: keep backups on a USB stick** (so a dead SD card doesn't take the backups with it).
This **erases the stick**:
```
lsblk                                   # find the stick, usually "sda" with a partition "sda1"
sudo mkfs.ext4 -L pfbackup /dev/sda1    # erase and format it (check it's the stick!)
sudo mkdir -p /mnt/backup
echo 'LABEL=pfbackup /mnt/backup ext4 defaults,nofail,noatime 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
sudo install -d -o pokefolio -g pokefolio /mnt/backup/pokefolio
```
Then `sudo nano /etc/pokefolio/backup.env`, set `BACKUP_DIR=/mnt/backup/pokefolio`, save, and run
the test backup again.

**Copy backups to your computer** now and then (run this **on your computer**, not the Pi):
```
scp "pi@pokefolio.local:/var/backups/pokefolio/*.dump" .
```
(Use `/mnt/backup/pokefolio/` if you moved them to the stick.)

**Restoring** (only in an emergency). Restore into a **new, empty** database, never over your live
one: in Neon → **Branches** → **Create branch** (or a new project), copy its connection string, then:
```
pg_restore --no-owner --no-privileges --dbname="<new database connection string>" /var/backups/pokefolio/pokefolio-YYYY-MM-DD_HHMM.dump
```
Check the data there, then point `DATABASE_URL` at it. The same command moves your data onto your
own PostgreSQL server later.

## Step 6 — Put the site on your domain (Cloudflare Tunnel)

**If your domain isn't on Cloudflare yet:** Cloudflare dashboard → **Add a domain** → enter it →
**Free** plan → Cloudflare shows two **nameservers**; set those at the company you bought the
domain from (in its DNS/nameserver settings). It's ready when Cloudflare emails you "active"
(usually within an hour). Or buy a domain in Cloudflare → **Domain Registration** → **Register**.

**If the domain currently points at Render:** Cloudflare → your domain → **DNS** → **Records** →
delete the record for that name (e.g. the `CNAME` for `@` or `www` pointing at `onrender.com`).
The tunnel creates its own record and can't while the old one exists.

Create the tunnel:
1. Cloudflare dashboard → **Zero Trust** (left menu; pick the Free plan if asked) →
   **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared** → name it `pokefolio` →
   **Save tunnel**.
2. Under "Install and run a connector", choose **Debian** and **arm64-bit**. Ignore the install
   lines (already done); copy **only** the last command, which looks like
   `sudo cloudflared service install eyJhIjoi…`, and run it **on the Pi**. A moment later the
   Cloudflare page shows the connector as **Connected** → **Next**.
3. **Public hostname** (newer dashboards call it **Published application routes**):
   - **Subdomain:** leave empty for `yourdomain.com`, or type `www` / `app`.
   - **Domain:** pick your domain.
   - **Service:** Type **HTTP**, URL `localhost:3000`.
   - **Save**.
4. Open `https://yourdomain.com` (any device, anywhere). PokéFolio should load with the padlock.

## Step 7 — Uptime monitoring (Uptime Kuma)

1. Install it:
   ```
   sudo bash /opt/pokefolio/app/pokemon-portfolio/deploy/raspberry-pi/uptime-kuma.sh
   ```
2. On your home network open `http://pokefolio.local:3001`, and create the Uptime Kuma admin
   account.
3. **Alerts first:** **Settings** → **Notifications** → **Setup Notification**. Easy choices:
   - **ntfy** (free phone app): install **ntfy** on your phone, subscribe to a hard-to-guess topic
     name (e.g. `pokefolio-alerts-x7k2`), and use the same topic name in Uptime Kuma.
   - **Discord:** in a Discord channel → **Edit Channel** → **Integrations** → **Webhooks** →
     **New Webhook** → **Copy Webhook URL**, and paste it into Uptime Kuma.
   - **Email (SMTP)**, e.g. Gmail with an "app password".

   Tick **Default enabled** and **Apply on all existing monitors**, **Test**, then **Save**.
4. **Add New Monitor** (top left), three times:

   | Monitor type | Friendly name | URL / setting | Heartbeat interval |
   |---|---|---|---|
   | HTTP(s) | PokéFolio — public site | `https://yourdomain.com/api/health?db=1` | 60 s |
   | HTTP(s) | PokéFolio — app on the Pi | `http://localhost:3000/api/health` | 60 s |
   | **Push** | PokéFolio — nightly backup | (copy the **Push URL** it shows) | `90000` s (25 hours) |

   The public-site check covers everything (internet, tunnel, app *and* Neon, thanks to `?db=1`).
   If it fails while "app on the Pi" is fine, the problem is the internet or the tunnel.
5. For the **backup** monitor: paste its Push URL into the backup settings and test:
   ```
   sudo nano /etc/pokefolio/backup.env        # BACKUP_PING_URL=<the push URL>
   sudo systemctl start pokefolio-backup
   ```
   The backup monitor turns green. If a backup ever fails, or doesn't run for 25 hours, you get
   an alert.

> Uptime Kuma runs *on the Pi*, so it can't tell you when the Pi itself or your home internet is
> down. For that, also add a free outside check: <https://uptimerobot.com> → **Add New Monitor** →
> HTTP(s) → `https://yourdomain.com/api/health?db=1` → every 5 minutes, with email alerts.

## Step 8 — Switch over from Render

Do this once the domain works (step 6):

1. **Stripe** (if you use Premium): Stripe → **Developers** → **Webhooks** → your endpoint →
   **⋯** → **Update details** → change the URL to `https://yourdomain.com/api/premium/webhook` →
   **Save**. The signing secret stays the same. Do it in **test mode and live mode** if you set
   up both. Then buy Premium once in test mode to check the webhook shows **200**.
2. **Twilio:** nothing to change.
3. Tell your users the new address (and to re-add the home-screen app from it). On the new
   address everyone **signs in once more**, and with two-factor on they get a texted code, because
   it's a "new device" for that address.
4. Leave Render running for a day or two in case you need to go back. Then **Render** → your
   service → **Settings** → **Suspend Web Service**, so only the Pi serves the site (live message
   pop-ups only reach people on the same server). Delete it once you're confident.

---

## Everyday commands (on the Pi)

| To… | Type |
|---|---|
| Update to the latest code | `sudo pokefolio-update` |
| See if the site is running | `systemctl status pokefolio` |
| Watch the app's log live (Ctrl + C to stop) | `journalctl -u pokefolio -f` |
| Restart the site | `sudo systemctl restart pokefolio` |
| Change settings | `sudo nano /etc/pokefolio/pokefolio.env`, then restart |
| Run a backup now | `sudo systemctl start pokefolio-backup` |
| List backups | `ls -lh /var/backups/pokefolio` |
| When is the next backup? | `systemctl list-timers pokefolio-backup` |
| Is the tunnel connected? | `systemctl status cloudflared` |
| Update Uptime Kuma | `sudo bash /opt/pokefolio/app/pokemon-portfolio/deploy/raspberry-pi/uptime-kuma.sh` |
| Restart the Pi | `sudo reboot` (everything starts again by itself) |

## Good to know

- **Power cuts:** everything starts again by itself. A small UPS (battery backup) avoids most
  outages and protects the SD card.
- **Security:** nothing on your router is opened. SSH and Uptime Kuma are only reachable from
  your home network. The Pi installs security updates automatically.
- **Neon's free plan** pauses the database after a few idle minutes; the first visit afterwards
  takes about a second longer.
- **Later, with your own database server:** install PostgreSQL there, restore last night's backup
  into it (the `pg_restore` command above), and change `DATABASE_URL`. That's the only change.

## Files in this folder

| File | What it is |
|---|---|
| `install.sh` | The one-time installer (step 3). |
| `update.sh` | Installed as `pokefolio-update`. Gets the latest code and restarts. |
| `pokefolio.service` | Runs the app at startup and restarts it if it stops. |
| `pokefolio.env.example` | Template for `/etc/pokefolio/pokefolio.env`. |
| `pokefolio-backup.sh` | The backup (installed as `/usr/local/bin/pokefolio-backup`). |
| `pokefolio-backup.service`, `.timer` | Run the backup every night. |
| `backup.env.example` | Template for `/etc/pokefolio/backup.env`. |
| `uptime-kuma.sh` | Installs or updates Uptime Kuma (Docker). |
