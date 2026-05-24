#!/bin/bash

# Diffract VPS UI Launcher Script
# Sets up and starts only the Diffract Next.js UI background service and Caddy proxy.
# Assumes Docker, OpenShell, Node, and NemoClaw CLI are already installed on your system.

set -e  # Exit on any error

# Make sure we are running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (using sudo)"
  exit 1
fi

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}=== $1 ===${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

PROJECT_ROOT=$(pwd)
UI_DIR="$PROJECT_ROOT/diffractui"

if [ ! -d "$UI_DIR" ]; then
    print_error "diffractui directory not found at $UI_DIR!"
    print_warning "Please run this script from the repository root directory (diffract-main)."
    exit 1
fi

# Fix execute permissions on NemoClaw wrapper binaries
print_warning "Fixing execute permissions for NemoClaw binaries..."
NEMOCLAW_DIR="$PROJECT_ROOT/NemoClaw"
if [ -d "$NEMOCLAW_DIR" ]; then
    chmod +x "$NEMOCLAW_DIR/bin/nemoclaw.js" 2>/dev/null || true
    chmod +x "$NEMOCLAW_DIR/bin/nemohermes.js" 2>/dev/null || true
    print_success "NemoClaw execute bits patched"
else
    print_warning "NemoClaw directory not found. Skipping execute permission configuration."
fi

# Step 1: Build Diffract UI Next.js App
print_header "Step 1: Building Diffract UI Next.js Application"

cd "$UI_DIR"
print_warning "Installing Next.js dependencies..."
npm install

print_warning "Building Next.js production build..."
npm run build
print_success "UI built successfully"

# Step 2: Create and Start systemd Service for Diffract UI
print_header "Step 2: Creating Next.js UI systemd Service"

NODE_PATH=$(which node || echo "/usr/bin/node")
NPM_PATH=$(which npm || echo "/usr/bin/npm")

# Write native systemd service unit file
cat <<EOF > /etc/systemd/system/diffractui.service
[Unit]
Description=Diffract Next.js Web UI Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$UI_DIR
Environment=PATH=$PATH
Environment=PORT=3000
Environment=NODE_ENV=production
Environment=DIFFRACT_PATH=$(which nemoclaw || echo "nemoclaw")
ExecStart=$NPM_PATH run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

print_warning "Enabling and booting diffractui service..."
systemctl daemon-reload
systemctl enable diffractui
systemctl restart diffractui

# Wait for process initialization and check status
sleep 3
if systemctl is-active --quiet diffractui; then
    print_success "Diffract UI background service is running on port 3000!"
else
    print_error "Diffract UI service failed to start. Run 'journalctl -u diffractui' for logs."
    exit 1
fi

# Step 3: Install and configure Caddy HTTPS proxy
print_header "Step 3: Configuring Caddy HTTPS Reverse Proxy"

if ! command -v caddy &> /dev/null; then
    print_warning "Installing Caddy Server..."
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install caddy -y
    print_success "Caddy server installed"
fi

# Set domain configuration or default to port 80 proxy
DOMAIN=$1
if [ -z "$DOMAIN" ]; then
    print_warning "No domain name argument specified."
    print_warning "Configuring Caddy to proxy on default port 80..."
    CADDY_CONFIG=":80 {
    handle_path /agent/* {
        reverse_proxy 127.0.0.1:18789
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}"
else
    print_success "Configuring Caddy reverse proxy for domain: $DOMAIN"
    CADDY_CONFIG="$DOMAIN {
    handle_path /agent/* {
        reverse_proxy 127.0.0.1:18789
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}"
fi

echo "$CADDY_CONFIG" > /etc/caddy/Caddyfile
systemctl restart caddy
print_success "Caddy proxy configured and active!"

# Finished!
print_header "Infrastructure Launch Complete!"
echo -e "${GREEN}✓ Diffract UI service is active on port 3000"
echo -e "✓ HTTPS/HTTP Caddy Proxy is configured${NC}\n"

if [ -n "$DOMAIN" ]; then
    echo -e "Access your secure web interface at: ${BLUE}https://$DOMAIN${NC}"
else
    echo -e "Access your secure web interface at: ${BLUE}http://<your-vps-ip>${NC}"
fi

echo -e "\nUseful commands:"
echo -e "  To check UI Server status:    ${YELLOW}systemctl status diffractui${NC}"
echo -e "  To restart UI Server:        ${YELLOW}systemctl restart diffractui${NC}"
echo -e "  To watch UI Server logs:      ${YELLOW}journalctl -u diffractui -f -n 50${NC}"
echo -e "  To check Caddy Server status: ${YELLOW}systemctl status caddy${NC}"
echo ""
