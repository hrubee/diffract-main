#!/bin/bash

# Diffract Unified Setup Script
# Automatically manages NVM (Node 22) and sets up CLI (local/WSL2) or full production stack (VPS).

set -e  # Exit on any error

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

# Parse arguments
USE_VPS=false
DOMAIN=""

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --vps)
            USE_VPS=true
            shift
            ;;
        *)
            DOMAIN="$1"
            USE_VPS=true # Passing a domain automatically enables VPS mode
            shift
            ;;
    esac
done

# Step 0: Root Check (Only for VPS mode)
if [ "$USE_VPS" = true ]; then
    if [ "$EUID" -ne 0 ]; then
        print_error "Please run as root (using sudo) when deploying to VPS."
        exit 1
    fi
fi

# Step 1: Load NVM and force Node v22
print_header "Setting up Node version with NVM"
NVM_FOUND=false

for path in "$HOME/.nvm/nvm.sh" "/root/.nvm/nvm.sh" "/home/ubuntu/.nvm/nvm.sh" "/home/debian/.nvm/nvm.sh"; do
    if [ -s "$path" ]; then
        print_warning "Loading NVM from $path..."
        . "$path"
        NVM_FOUND=true
        break
    fi
done

if [ "$NVM_FOUND" = true ]; then
    print_warning "Switching to Node v22..."
    nvm use 22 || {
        print_warning "Node v22 is not installed in NVM. Attempting to install..."
        nvm install 22
        nvm use 22
    }
    print_success "Using Node version: $(node -v)"
elif command -v node &> /dev/null; then
    print_warning "NVM not found, but Node.js is installed globally."
    print_warning "Current Node version: $(node -v)"
    if [[ "$(node -v)" != v22* ]]; then
        print_warning "WARNING: Node version is not v22. Setup may experience issues."
    fi
else
    print_error "NVM and Node.js not found! Please install Node.js (v22 recommended) before running this script."
    exit 1
fi

# Step 2: Uninstall existing NemoClaw if present
print_header "Checking for Existing NemoClaw Installation"

if command -v nemoclaw &> /dev/null; then
    NEMOCLAW_PATH=$(which nemoclaw)
    print_warning "Found existing nemoclaw at: $NEMOCLAW_PATH"
    print_warning "Uninstalling existing global nemoclaw..."
    npm uninstall -g nemoclaw 2>/dev/null || true
    
    # Also remove the binary directly if it still exists
    if [ -f "$NEMOCLAW_PATH" ]; then
        rm -f "$NEMOCLAW_PATH"
        print_warning "Removed binary at: $NEMOCLAW_PATH"
    fi
    
    print_success "Existing nemoclaw uninstalled"
else
    print_success "No existing nemoclaw installation found"
fi

# Verify it's gone
if command -v nemoclaw &> /dev/null; then
    print_warning "nemoclaw still found, attempting to remove: $(which nemoclaw)"
    rm -f "$(which nemoclaw)"
fi

# Final check
if command -v nemoclaw &> /dev/null; then
    print_error "Failed to uninstall existing nemoclaw at: $(which nemoclaw)"
    exit 1
fi

# Step 3: Verify prerequisites
print_header "Verifying Prerequisites"

if ! command -v docker &> /dev/null; then
    print_warning "Docker is not installed or not in PATH"
    if [ "$USE_VPS" = false ]; then
        print_error "Docker is required for local NemoClaw sandboxes. Exiting."
        exit 1
    fi
elif ! docker ps &> /dev/null; then
    print_warning "Docker daemon is not responding"
    if [ "$USE_VPS" = false ]; then
        print_error "Docker is required for local NemoClaw sandboxes. Exiting."
        exit 1
    fi
else
    print_success "Docker is running"
fi

# Step 4: Install OpenShell Runtime
print_header "Installing OpenShell Runtime"

if command -v openshell &> /dev/null; then
    print_success "OpenShell is already installed"
else
    print_warning "Installing OpenShell..."
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
    source ~/.bashrc 2>/dev/null || true
    print_success "OpenShell installed successfully"
fi

# Step 5: Build and Install NemoClaw CLI globally
print_header "Building and Installing NemoClaw CLI Globally"
PROJECT_ROOT=$(pwd)
NEMOCLAW_DIR="$PROJECT_ROOT/NemoClaw"

if [ ! -d "$NEMOCLAW_DIR" ]; then
    print_error "NemoClaw directory not found at: $NEMOCLAW_DIR"
    exit 1
fi

cd "$NEMOCLAW_DIR"
print_warning "Updating npm..."
npm install -g npm@latest
print_warning "Installing CLI dependencies..."
npm install
print_warning "Building CLI typescript project..."
npm run build:cli
print_warning "Installing NemoClaw CLI globally..."
npm install -g .
cd "$PROJECT_ROOT"
print_success "NemoClaw CLI installed globally"

# ----------------- VPS-ONLY DEPLOYMENT STEPS -----------------
if [ "$USE_VPS" = true ]; then
    print_header "VPS Mode: Deploying Web UI and Reverse Proxy"

    UI_DIR="$PROJECT_ROOT/diffractui"
    if [ ! -d "$UI_DIR" ]; then
        print_error "diffractui directory not found at $UI_DIR!"
        exit 1
    fi

    # Fix permissions on NemoClaw wrapper binaries
    print_warning "Fixing execute permissions for NemoClaw binaries..."
    chmod +x "$NEMOCLAW_DIR/bin/nemoclaw.js" 2>/dev/null || true
    chmod +x "$NEMOCLAW_DIR/bin/nemohermes.js" 2>/dev/null || true
    print_success "NemoClaw execute bits patched"

    # Build Web UI Next.js app
    print_warning "Building Next.js UI Application..."
    cd "$UI_DIR"
    npm install
    npm run build
    print_success "UI built successfully"

    # Create & start systemd diffractui service
    print_warning "Configuring Systemd service..."
    NODE_PATH=$(which node || echo "/usr/bin/node")
    NPM_PATH=$(which npm || echo "/usr/bin/npm")

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

    systemctl daemon-reload
    systemctl enable diffractui
    systemctl restart diffractui

    sleep 3
    if systemctl is-active --quiet diffractui; then
        print_success "Diffract UI service is running on port 3000!"
    else
        print_error "Diffract UI service failed to start. Check journalctl -u diffractui"
        exit 1
    fi

    # Configure Caddy Proxy
    print_warning "Configuring Caddy Proxy..."
    if ! command -v caddy &> /dev/null; then
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
        apt-get update
        apt-get install caddy -y
    fi

    if [ -z "$DOMAIN" ]; then
        print_warning "No domain name argument specified. Proxying on port 80..."
        CADDY_CONFIG=":80 {
        handle_path /agent/* {
            reverse_proxy 127.0.0.1:9119
        }
        handle {
            reverse_proxy 127.0.0.1:3000
        }
    }"
    else
        print_success "Configuring Caddy for domain: $DOMAIN"
        CADDY_CONFIG="$DOMAIN {
        handle_path /agent/* {
            reverse_proxy 127.0.0.1:9119
        }
        handle {
            reverse_proxy 127.0.0.1:3000
        }
    }"
    fi

    echo "$CADDY_CONFIG" > /etc/caddy/Caddyfile
    systemctl restart caddy
    print_success "Caddy proxy configured and active!"
fi

print_header "Setup Complete!"
if [ "$USE_VPS" = true ]; then
    echo -e "${GREEN}✓ Diffract UI service is active on port 3000"
    echo -e "✓ HTTPS/HTTP Caddy Proxy is configured${NC}\n"
    if [ -n "$DOMAIN" ]; then
        echo -e "Access secure interface: ${BLUE}https://$DOMAIN${NC}"
    else
        echo -e "Access secure interface: ${BLUE}http://<your-vps-ip>${NC}"
    fi
else
    echo -e "${GREEN}Local NemoClaw CLI setup succeeded!${NC}"
    echo "Run 'nemoclaw onboard' to configure your environment."
fi
