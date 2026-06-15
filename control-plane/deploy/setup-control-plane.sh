#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the Diffract control plane on a fresh CONTROL VPS (Ubuntu/Debian, root).
#
#   sudo bash deploy/setup-control-plane.sh
#
# Installs Node 22 (NodeSource) + Caddy, copies this folder to /opt/diffract-control,
# seeds .env from .env.example (you fill the secrets), installs the systemd unit +
# Caddyfile, and starts everything. Re-runnable.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEST=/opt/diffract-control
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the control-plane/ dir

log()  { echo -e "\033[0;34m[control-setup]\033[0m $*"; }
die()  { echo -e "\033[0;31m✗ $*\033[0m" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v apt-get >/dev/null 2>&1 || die "Debian/Ubuntu only (apt-get not found)"
export DEBIAN_FRONTEND=noninteractive

# ── Node 22 (system-wide, so systemd can exec /usr/bin/node) ──────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  log "Installing Node 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "Node $(node -v)"

# ── Caddy ─────────────────────────────────────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy…"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# ── Copy app to /opt (excluding any local .env + data) ───────────────────────
log "Installing app to $DEST…"
mkdir -p "$DEST"
cp -a "$SRC_DIR/src" "$SRC_DIR/package.json" "$DEST/"
mkdir -p "$DEST/deploy"
cp -a "$SRC_DIR/deploy/." "$DEST/deploy/"

# ── Seed .env (operator fills secrets) ───────────────────────────────────────
if [ ! -f "$DEST/.env" ]; then
  cp "$SRC_DIR/.env.example" "$DEST/.env"
  chmod 600 "$DEST/.env"
  NEEDS_ENV=1
  log "Wrote $DEST/.env from template — FILL IN THE SECRETS before the service will start."
else
  log ".env already present — leaving it."
fi

# ── Caddyfile ────────────────────────────────────────────────────────────────
if [ ! -f /etc/caddy/Caddyfile ] || ! grep -q "diffract control-plane ingress" /etc/caddy/Caddyfile 2>/dev/null; then
  install -m 0644 "$SRC_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  log "Installed /etc/caddy/Caddyfile (edit the email/domain to match your account)."
fi
systemctl enable --now caddy || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy || true

# ── systemd unit ──────────────────────────────────────────────────────────────
install -m 0644 "$SRC_DIR/deploy/diffract-control.service" /etc/systemd/system/diffract-control.service
systemctl daemon-reload
systemctl enable diffract-control

if [ "${NEEDS_ENV:-0}" = "1" ]; then
  cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Control plane installed but NOT started — it needs secrets first.

 1) Edit $DEST/.env  (Hostinger token + catalog ids, Dodo webhook secret,
    INGRESS_PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}'), INJECT_INFERENCE_KEY, ADMIN_API_TOKEN)
 2) Edit /etc/caddy/Caddyfile email + domain, then: systemctl reload caddy
 3) Point DNS:  *.diffraction.in  ->  $(hostname -I 2>/dev/null | awk '{print $1}')   (one wildcard A record)
 4) Start:      systemctl start diffract-control && journalctl -u diffract-control -f
 5) In Dodo, set the webhook URL to:  https://cp.diffraction.in/webhooks/dodo
────────────────────────────────────────────────────────────────────────────
EOF
else
  systemctl restart diffract-control
  log "Restarted diffract-control. Logs: journalctl -u diffract-control -f"
fi
