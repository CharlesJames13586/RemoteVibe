#!/usr/bin/env bash
# infra/deploy.sh — one-shot cloud server setup for Remote Control
#
# Target: Ubuntu 22.04+ cloud VM with a domain already pointed at its public IP.
# Run as: sudo bash deploy.sh your-domain.com
#
# What it does:
#   1. Installs Node.js, Nginx, coturn, certbot
#   2. Installs signaling-server dependencies
#   3. Configures Nginx reverse proxy + obtains a Let's Encrypt TLS cert
#   4. Configures coturn with a generated auth secret + the server's public IP
#   5. Deploys signaling-server as a systemd service, wired to the same TURN
#      secret so it can mint short-lived TURN REST credentials for clients
#   6. Opens the required firewall ports (if ufw is active)
#
# After running, print the values you need to paste into mac-agent's
# SIGNAL_URL env var. TURN credentials are issued automatically by the
# signaling server — no manual TURN secret handling needed by clients.

set -euo pipefail

DOMAIN="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy.sh your-domain.com" >&2
  exit 1
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "This script must be run as root (sudo bash deploy.sh $DOMAIN)" >&2
  exit 1
fi

bold=$'\033[1m'; reset=$'\033[0m'; green=$'\033[32m'
header() { printf "\n${bold}%s${reset}\n" "$*"; }
success() { printf " ${green}✓${reset} %s\n" "$*"; }

# ── 1. System packages ──────────────────────────────────────────────────────
header "Installing system packages"
apt-get update -qq
apt-get install -y -qq curl nginx coturn certbot python3-certbot-nginx ufw

if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
success "Node $(node -v), Nginx, coturn, certbot installed"

# ── 2. Deploy signaling-server ──────────────────────────────────────────────
header "Deploying signaling-server"
cd "$REPO_DIR/signaling-server"
npm install --omit=dev --silent
success "signaling-server dependencies installed (systemd service created after coturn, step 4 below)"

# ── 3. Nginx + TLS ───────────────────────────────────────────────────────────
header "Configuring Nginx + obtaining TLS certificate"
sed "s/YOUR_DOMAIN/${DOMAIN}/g" "$REPO_DIR/infra/nginx.conf" > /etc/nginx/sites-available/remote-control
ln -sf /etc/nginx/sites-available/remote-control /etc/nginx/sites-enabled/remote-control
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# Obtain cert (interactive-free, assumes DNS already points here)
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect || {
  echo "certbot failed — check that ${DOMAIN} DNS A record points to this server's public IP" >&2
  exit 1
}
success "TLS certificate issued for ${DOMAIN}"

# ── 4. coturn ─────────────────────────────────────────────────────────────────
header "Configuring coturn TURN server"
PUBLIC_IP=$(curl -s https://api.ipify.org)
TURN_SECRET=$(openssl rand -hex 32)

id -u turnserver &>/dev/null || useradd -r -s /usr/sbin/nologin turnserver

sed \
  -e "s/YOUR_DOMAIN/${DOMAIN}/g" \
  -e "s/YOUR_PUBLIC_IP/${PUBLIC_IP}/g" \
  -e "s/YOUR_TURN_SECRET/${TURN_SECRET}/g" \
  "$REPO_DIR/infra/coturn.conf" > /etc/turnserver.conf

sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || \
  echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn

systemctl enable coturn
systemctl restart coturn
success "coturn running (public IP: ${PUBLIC_IP})"

# ── 5. signaling-server systemd service ────────────────────────────────────
# Must come AFTER coturn so TURN_SECRET exists — the signaling server uses
# it to mint short-lived TURN REST credentials for clients (plan.md §4),
# via the same static-auth-secret that's baked into /etc/turnserver.conf
# above. If TURN_SECRET/TURN_DOMAIN were missing, clients would silently
# fall back to STUN-only and fail to connect over 4G/5G/restrictive NATs.
header "Registering signaling-server as a systemd service"
cat > /etc/systemd/system/remote-control-signal.service <<SERVICE
[Unit]
Description=Remote Control Signaling Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}/signaling-server
ExecStart=$(command -v node) index.js
Environment=SIGNAL_PORT=8080
Environment=WEB_VIEWER_DIR=${REPO_DIR}/web-viewer
Environment=TURN_SECRET=${TURN_SECRET}
Environment=TURN_DOMAIN=${DOMAIN}
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable remote-control-signal
systemctl restart remote-control-signal
success "signaling-server running as a systemd service (TURN credentials endpoint active)"

# ── 6. Firewall ───────────────────────────────────────────────────────────────
header "Opening firewall ports"
ufw allow 80/tcp   >/dev/null || true
ufw allow 443/tcp  >/dev/null || true
ufw allow 3478/tcp >/dev/null || true
ufw allow 3478/udp >/dev/null || true
ufw allow 5349/tcp >/dev/null || true
ufw allow 49152:65535/udp >/dev/null || true
success "ufw rules added (80, 443, 3478, 5349, 49152-65535/udp)"
echo " Note: if this is a cloud VM (AWS/aliyun/etc.), also open these same ports"
echo " in the provider's Security Group / firewall console — ufw alone is not enough."

# ── Summary ───────────────────────────────────────────────────────────────────
printf "\n${bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}\n"
printf "${green}${bold} ✓ Deployment complete${reset}\n"
printf "${bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}\n\n"
printf " Signaling + Web Viewer: https://%s\n" "$DOMAIN"
printf " TURN server:            turn:%s:3478 (REST credentials auto-issued by signaling-server)\n\n" "$DOMAIN"
printf " On your Mac, run the Agent with:\n"
printf "   SIGNAL_URL=wss://%s npm start   (from mac-agent/)\n\n" "$DOMAIN"
printf " Logs:\n"
printf "   journalctl -u remote-control-signal -f\n"
printf "   tail -f /var/log/turnserver.log\n\n"
