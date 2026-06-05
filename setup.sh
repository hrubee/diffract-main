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

# Locate the installed Hermes source checkout (a directory containing the
# hermes_cli/ and ui-tui/ source). Echoes the path on success, returns 1 if
# none is found. Override with HERMES_AGENT_DIR=/path/to/hermes-agent.
resolve_hermes_dir() {
    local candidates=(
        "$HERMES_AGENT_DIR"
        "/usr/local/lib/hermes-agent"
        "$HOME/.hermes/hermes-agent"
        "/root/.hermes/hermes-agent"
    )
    local d
    # Only require hermes_cli/ — some installs (e.g. the VPS host copy) ship the
    # web UI + Python but not the ui-tui source. Each piece is applied only if
    # it actually exists at the destination.
    for d in "${candidates[@]}"; do
        if [ -n "$d" ] && [ -d "$d/hermes_cli" ]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}

# Overlay branding onto a HOST Hermes checkout ($2), from local source ($1).
# Applies only the pieces that exist at the destination; builds are non-fatal.
_overlay_host() {
    local SRC="$1" DEST="$2"
    if [ -d "$DEST/ui-tui" ] && [ -d "$SRC/ui-tui/src" ]; then
        print_warning "  host: ui-tui src + rebuild"
        cp -a "$SRC/ui-tui/src/." "$DEST/ui-tui/src/"
        ( cd "$DEST/ui-tui" && npm install && npm run build ) || print_warning "  host ui-tui build failed"
    fi
    [ -f "$DEST/hermes_cli/banner.py" ]     && cp -f "$SRC/hermes_cli/banner.py"     "$DEST/hermes_cli/banner.py"     || true
    [ -f "$DEST/hermes_cli/web_server.py" ] && cp -f "$SRC/hermes_cli/web_server.py" "$DEST/hermes_cli/web_server.py" || true
    [ -f "$DEST/tui_gateway/server.py" ]    && cp -f "$SRC/tui_gateway/server.py"    "$DEST/tui_gateway/server.py"    || true
    if [ -d "$DEST/web" ] && [ -d "$SRC/web/src" ]; then
        print_warning "  host: web src + rebuild (-> hermes_cli/web_dist)"
        cp -a "$SRC/web/src/." "$DEST/web/src/"
        ( cd "$DEST/web" && npm install && npm run build ) || print_warning "  host web build failed"
    fi
    print_success "  host overlay applied: $DEST"
}

# Overlay branding INTO a running OpenShell sandbox container ($2), from local
# source ($1). On a VPS the agent runs inside the container at /opt/hermes, so
# we build the bundles on the host (Node 22 is here) and docker cp the outputs
# in — no Node needed inside the container. Everything is guarded/non-fatal.
_overlay_container() {
    local SRC="$1" cid="$2"

    # Web -> /opt/hermes/web_dist  (vite outputs to hermes/hermes_cli/web_dist)
    if [ -d "$SRC/web/src" ]; then
        print_warning "  container: build web + copy web_dist"
        ( cd "$SRC/web" && npm install && npm run build ) || print_warning "  web build failed"
        if [ -d "$SRC/hermes_cli/web_dist" ]; then
            docker exec "$cid" mkdir -p /opt/hermes/web_dist 2>/dev/null || true
            docker cp "$SRC/hermes_cli/web_dist/." "$cid:/opt/hermes/web_dist/" 2>/dev/null \
                && print_success "  web_dist copied into container" || print_warning "  web_dist copy failed"
        fi
    fi

    # TUI bundle -> wherever the container loads entry.js from (discovered live)
    if [ -d "$SRC/ui-tui" ]; then
        print_warning "  container: build TUI + copy entry.js"
        ( cd "$SRC/ui-tui" && npm install && npm run build ) || print_warning "  TUI build failed"
        if [ -f "$SRC/ui-tui/dist/entry.js" ]; then
            local tpath
            tpath=$(docker exec "$cid" sh -c 'ls /opt/hermes/hermes_cli/tui_dist/entry.js /opt/hermes/ui-tui/dist/entry.js 2>/dev/null | head -1' 2>/dev/null | tr -d '\r') || true
            if [ -n "$tpath" ]; then
                docker cp "$SRC/ui-tui/dist/entry.js" "$cid:$tpath" 2>/dev/null \
                    && print_success "  TUI bundle -> $tpath" || print_warning "  TUI copy failed"
            else
                print_warning "  could not locate TUI entry.js inside container (skipped)"
            fi
        fi
    fi

    # Python branding (welcome banner, TUI gateway info, web server /docs)
    docker cp "$SRC/hermes_cli/banner.py"     "$cid:/opt/hermes/hermes_cli/banner.py"     2>/dev/null || true
    docker cp "$SRC/hermes_cli/web_server.py" "$cid:/opt/hermes/hermes_cli/web_server.py" 2>/dev/null || true
    docker cp "$SRC/tui_gateway/server.py"    "$cid:/opt/hermes/tui_gateway/server.py"    2>/dev/null || true
    print_success "  container overlay applied: $cid"
}

# Overlay the local custom Hermes branding onto wherever Hermes actually lives:
#   - a HOST checkout (local/WSL, or the VPS host copy used for web_dist), and
#   - the running OpenShell sandbox container (VPS, agent runs at /opt/hermes).
# Runs in both local and VPS modes so branding survives a reinstall. Best-effort
# and non-fatal: missing targets are skipped with a warning, never an error.
apply_diffract_branding() {
    print_header "Applying Diffract Branding to Installed Hermes"

    local SRC="$PROJECT_ROOT/hermes"
    if [ ! -d "$SRC" ]; then
        print_warning "Local hermes source not found at $SRC — skipping branding overlay."
        return 0
    fi

    local did=0

    # --- Host-level Hermes checkout ---
    local DEST
    if DEST=$(resolve_hermes_dir); then
        print_success "Found host Hermes at: $DEST"
        _overlay_host "$SRC" "$DEST"
        did=1
    fi

    # --- Hermes inside a running OpenShell sandbox container (VPS) ---
    if command -v docker >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 \
        && [ -f "$HOME/.nemoclaw/sandboxes.json" ]; then
        local sb cid
        sb=$(jq -r ".defaultSandbox // empty" "$HOME/.nemoclaw/sandboxes.json" 2>/dev/null) || true
        [ -n "$sb" ] && cid=$(docker ps -q -f "name=openshell-${sb}" 2>/dev/null | head -1) || true
        if [ -n "${cid:-}" ] && docker exec "$cid" test -d /opt/hermes/hermes_cli 2>/dev/null; then
            print_success "Found Hermes in sandbox container: ${sb} (${cid})"
            _overlay_container "$SRC" "$cid"
            did=1
        fi
    fi

    if [ "$did" = 0 ]; then
        print_warning "No installed Hermes found on the host or in a running sandbox container."
        print_warning "On a VPS the agent lives inside the sandbox — run 'nemoclaw onboard' first so the"
        print_warning "container exists, then re-run setup.sh. (Override host path with HERMES_AGENT_DIR.)"
    else
        print_success "Diffract branding overlay complete."
    fi
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
    NEMOCLAW_PATH=$(command -v nemoclaw)
    print_warning "Found existing nemoclaw at: $NEMOCLAW_PATH"
    print_warning "Uninstalling existing global nemoclaw..."
    npm uninstall -g nemoclaw 2>/dev/null || true
    
    # Also remove the binary directly if it still exists
    if [ -n "$NEMOCLAW_PATH" ] && [ -f "$NEMOCLAW_PATH" ]; then
        rm -f "$NEMOCLAW_PATH"
        print_warning "Removed binary at: $NEMOCLAW_PATH"
    fi
    
    print_success "Existing nemoclaw uninstalled"
else
    print_success "No existing nemoclaw installation found"
fi

# Verify it's gone
if command -v nemoclaw &> /dev/null; then
    print_warning "nemoclaw still found, attempting to remove: $(command -v nemoclaw)"
    rm -f "$(command -v nemoclaw)"
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

# Step 4.5: Sync local custom Hermes code to NemoClaw build context
print_header "Syncing Custom Hermes Source"
PROJECT_ROOT=$(pwd)
NEMOCLAW_DIR="$PROJECT_ROOT/NemoClaw"
LOCAL_HERMES_DIR="$PROJECT_ROOT/hermes"

if [ -d "$LOCAL_HERMES_DIR" ]; then
    print_warning "Syncing custom Hermes codebase from $LOCAL_HERMES_DIR to NemoClaw build context..."
    rm -rf "$NEMOCLAW_DIR/agents/hermes/hermes"
    mkdir -p "$NEMOCLAW_DIR/agents/hermes/hermes"
    # Copy all files including hidden ones
    cp -a "$LOCAL_HERMES_DIR/." "$NEMOCLAW_DIR/agents/hermes/hermes/"
    print_success "Hermes source synchronized successfully!"
else
    print_warning "Source directory $LOCAL_HERMES_DIR not found, skipping sync"
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
# Fix permissions on NemoClaw wrapper binaries before installing globally
print_warning "Fixing execute permissions for NemoClaw binaries..."
chmod +x "./bin/nemoclaw.js" 2>/dev/null || true
chmod +x "./bin/nemohermes.js" 2>/dev/null || true
print_success "NemoClaw execute bits patched"

print_warning "Installing NemoClaw CLI globally..."
npm install -g .

# Double insurance: ensure global binaries themselves have execute permissions
NEMOCLAW_GLOBAL_PATH=$(which nemoclaw 2>/dev/null || true)
NEMOHERMES_GLOBAL_PATH=$(which nemohermes 2>/dev/null || true)
[ -n "$NEMOCLAW_GLOBAL_PATH" ] && chmod +x "$NEMOCLAW_GLOBAL_PATH" 2>/dev/null || true
[ -n "$NEMOHERMES_GLOBAL_PATH" ] && chmod +x "$NEMOHERMES_GLOBAL_PATH" 2>/dev/null || true

cd "$PROJECT_ROOT"
print_success "NemoClaw CLI installed globally"

# Step 6: Overlay custom Diffract branding onto the installed Hermes and
# rebuild (web + TUI + Python). Runs in both local and VPS modes.
apply_diffract_branding

# ----------------- VPS-ONLY DEPLOYMENT STEPS -----------------
if [ "$USE_VPS" = true ]; then
    print_header "VPS Mode: Deploying Web UI and Reverse Proxy"

    UI_DIR="$PROJECT_ROOT/diffractui"
    if [ ! -d "$UI_DIR" ]; then
        print_error "diffractui directory not found at $UI_DIR!"
        exit 1
    fi

    # Build Web UI Next.js app
    print_warning "Building Next.js UI Application..."
    cd "$UI_DIR"
    npm install
    npm run build
    print_success "UI built successfully"

    # NOTE: The custom Hermes web UI + TUI + Python branding are applied and
    # rebuilt earlier by apply_diffract_branding (Step 6), so there is no
    # separate Hermes UI build step here.

    # Create & start systemd diffractui service
    print_warning "Configuring Systemd services..."
    NODE_PATH=$(which node || echo "/usr/bin/node")
    NPM_PATH=$(which npm || echo "/usr/bin/npm")

    # Admin auth secrets for the Diffract UI (Phase-0 readiness: no
    # unauthenticated control surface). Stored in a 0600 EnvironmentFile so they
    # are NOT exposed in the world-readable systemd unit. Generated once and
    # reused on re-runs so the admin password stays stable; pass
    # DIFFRACT_ADMIN_PASSWORD in the environment to set your own.
    DIFFRACT_ENV_FILE=/etc/diffractui.env
    if [ -f "$DIFFRACT_ENV_FILE" ]; then
        print_warning "Reusing existing admin auth secrets at $DIFFRACT_ENV_FILE"
        # shellcheck disable=SC1090
        . "$DIFFRACT_ENV_FILE"
    fi
    DIFFRACT_AUTH_SECRET="${DIFFRACT_AUTH_SECRET:-$(openssl rand -hex 32)}"
    DIFFRACT_ADMIN_PASSWORD="${DIFFRACT_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)}"
    umask 077
    cat <<EOF > "$DIFFRACT_ENV_FILE"
DIFFRACT_AUTH_SECRET=$DIFFRACT_AUTH_SECRET
DIFFRACT_ADMIN_PASSWORD=$DIFFRACT_ADMIN_PASSWORD
EOF
    chmod 600 "$DIFFRACT_ENV_FILE"
    umask 022

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
EnvironmentFile=$DIFFRACT_ENV_FILE
ExecStart=$NPM_PATH run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    # Install dependencies for the wrapper script
    apt-get install -y jq socat

    cat <<'EOF' > /usr/local/bin/sandbox-port-forwarder.sh
#!/bin/bash
set -e
SANDBOX_NAME=$(jq -r ".defaultSandbox" ~/.nemoclaw/sandboxes.json)
if [ -z "$SANDBOX_NAME" ] || [ "$SANDBOX_NAME" = "null" ]; then
    echo "No default sandbox found."
    sleep 5
    exit 1
fi
CONTAINER_ID=$(docker ps -q -f "name=openshell-${SANDBOX_NAME}")
if [ -z "$CONTAINER_ID" ]; then
    echo "Sandbox container not running. Retrying in 5s..."
    sleep 5
    exit 1
fi

echo "Copying UI assets to container $CONTAINER_ID..."
docker exec $CONTAINER_ID mkdir -p /opt/hermes/web_dist
docker cp /usr/local/lib/hermes-agent/hermes_cli/web_dist/. $CONTAINER_ID:/opt/hermes/web_dist/

echo "Finding container IP..."
CONTAINER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $CONTAINER_ID)

echo "Starting socat forwarder on port 9119 to $CONTAINER_IP:9119..."
socat TCP-LISTEN:9119,fork,reuseaddr TCP:$CONTAINER_IP:9119 &
SOCAT_PID1=$!

echo "Starting socat forwarder on port 8642 to $CONTAINER_IP:8642..."
socat TCP-LISTEN:8642,fork,reuseaddr TCP:$CONTAINER_IP:8642 &
SOCAT_PID2=$!

# Stop any stale dashboard inside the container so the fresh one can bind 9119,
# and make sure both the dashboard and the socat forwarders are torn down when
# this service stops/restarts.
docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --stop || true
trap "kill $SOCAT_PID1 $SOCAT_PID2; docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --stop || true" EXIT

# Launch the Hermes dashboard WITH embedded TUI chat (--tui).
#   - --tui enables the /api/ws chat WebSocket; without it the dashboard injects
#     __HERMES_DASHBOARD_EMBEDDED_CHAT__=false and the chat is hidden / refused (4403).
#   - We SOURCE /tmp/nemoclaw-proxy-env.sh (written by NemoClaw start.sh) so the
#     dashboard inherits the SAME OpenShell proxy + CA + HERMES_HOME the gateway uses.
#     The model API key is NOT in the sandbox — it lives in OpenShell on the host (set
#     during Diffract onboard) and is injected at the egress proxy. Without this env the
#     agent's inference calls to https://inference.local/v1 can't resolve/authenticate,
#     so the chat connects but never replies.
# Foreground so this systemd service supervises it (Restart=always brings it back).
echo "Starting Hermes dashboard (embedded TUI chat, OpenShell inference) in container..."
docker exec -e HERMES_WEB_DIST=/opt/hermes/web_dist $CONTAINER_ID \
  bash -c '. /tmp/nemoclaw-proxy-env.sh 2>/dev/null; exec /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --host 0.0.0.0 --skip-build --insecure --tui'
EOF
    chmod +x /usr/local/bin/sandbox-port-forwarder.sh

    # Create & start systemd port forwarder service
    cat <<EOF > /etc/systemd/system/sandbox-port-forwarder.service
[Unit]
Description=Sandbox Port Forwarder (Dashboard & API)
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/usr/local/lib/hermes-agent
Environment=PATH=$PATH
ExecStart=/usr/local/bin/sandbox-port-forwarder.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable sandbox-port-forwarder.service
    systemctl restart sandbox-port-forwarder.service
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
        CADDY_CONFIG="srv1670849.hstgr.cloud {
        redir /agent /agent/
        
        handle /v1/* {
            reverse_proxy 127.0.0.1:8642 {
                header_up Host {upstream_hostport}
            }
        }

        handle_path /agent/* {
            reverse_proxy 127.0.0.1:9119 {
                header_up Host {upstream_hostport}
                header_up X-Forwarded-Prefix /agent
            }
        }
        handle /assets/* {
            reverse_proxy 127.0.0.1:9119 {
                header_up Host {upstream_hostport}
            }
        }
        handle {
            reverse_proxy 127.0.0.1:3000
        }
    }"
    else
        print_success "Configuring Caddy for domain: $DOMAIN"
        CADDY_CONFIG="$DOMAIN {
        redir /agent /agent/

        handle /v1/* {
            reverse_proxy 127.0.0.1:8642 {
                header_up Host {upstream_hostport}
            }
        }

        handle_path /agent/* {
            reverse_proxy 127.0.0.1:9119 {
                header_up Host {upstream_hostport}
                header_up X-Forwarded-Prefix /agent
            }
        }
        handle /assets/* {
            reverse_proxy 127.0.0.1:9119 {
                header_up Host {upstream_hostport}
            }
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
    echo -e "\n${YELLOW}── Admin login (Diffract UI is now password-protected) ──${NC}"
    echo -e "  Username:  (none — password only)"
    echo -e "  Password:  ${GREEN}${DIFFRACT_ADMIN_PASSWORD}${NC}"
    echo -e "  Stored at: ${DIFFRACT_ENV_FILE} (root-only, 0600)"
    echo -e "  ${YELLOW}Save this now. To change it: edit ${DIFFRACT_ENV_FILE} and 'systemctl restart diffractui'.${NC}"
else
    echo -e "${GREEN}Local NemoClaw CLI setup succeeded!${NC}"
    echo "Run 'nemoclaw onboard' to configure your environment."
fi
