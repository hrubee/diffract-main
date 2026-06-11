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
        # index.html carries the <title> (vite uses it as the build template); it lives
        # in web/ not web/src, so it must be copied explicitly or the browser tab keeps
        # the old brand even after a rebrand.
        [ -f "$SRC/web/index.html" ] && cp -f "$SRC/web/index.html" "$DEST/web/index.html" || true
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

    # IMPORTANT: do NOT patch the in-container TUI (ui-tui) or Python (banner.py,
    # tui_gateway, web_server) here. The sandbox runs a *pinned-image* Hermes
    # whose version can differ from this repo. Overlaying this repo's newer
    # ui-tui/tui_gateway source onto the older in-container Hermes breaks the
    # TUI↔gateway protocol and the chat session ends immediately ("session
    # ended"). Only the self-contained web dashboard (web_dist, handled above)
    # is safe to overlay live. To rebrand the sandbox TUI, bake the branding
    # into a version-matched sandbox image instead of live-patching.
    print_success "  container overlay applied (web only): $cid"
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
    # Canonical Diffract agent identity (single source of truth; also baked into
    # the sandbox image by NemoClaw/agents/hermes/Dockerfile).
    local _soul="$PROJECT_ROOT/NemoClaw/agents/hermes/SOUL.md"

    # --- Host-level Hermes checkout ---
    local DEST
    if DEST=$(resolve_hermes_dir); then
        print_success "Found host Hermes at: $DEST"
        _overlay_host "$SRC" "$DEST"
        # Stage the canonical SOUL.md on the host so the port-forwarder can
        # re-apply it into the sandbox on each start (until a rebuilt image ships it).
        [ -f "$_soul" ] && cp -f "$_soul" "$DEST/SOUL.md" || true
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
            # Apply the Diffract agent identity (SOUL.md) into the sandbox now. It's a
            # data file (the agent's primary identity), safe to overlay live — unlike
            # the version-skew-sensitive Python/TUI that _overlay_container avoids.
            if [ -f "$_soul" ]; then
                docker cp "$_soul" "$cid:/sandbox/.hermes/SOUL.md" 2>/dev/null \
                  && docker exec "$cid" sh -c 'chown sandbox:sandbox /sandbox/.hermes/SOUL.md 2>/dev/null; chmod 0644 /sandbox/.hermes/SOUL.md' 2>/dev/null \
                  && print_success "  Diffract agent identity (SOUL.md) applied to sandbox"
            fi
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

    # Install the sandbox persistence helper (back up / restore the user's
    # working files across destroy/recreate — OpenShell sandboxes have no
    # volume, so the host is the only durable store). Used by the forwarder
    # (restore-on-boot + periodic backup) and the diffractui destroy handler
    # (backup-before-destroy). See scripts/diffract-persist.sh.
    if [ -f "$PROJECT_ROOT/scripts/diffract-persist.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-persist.sh" /usr/local/bin/diffract-persist.sh \
            && print_success "  installed diffract-persist.sh"
    else
        print_warning "  scripts/diffract-persist.sh not found; sandbox file persistence disabled"
    fi
    mkdir -p /var/lib/diffract/persist

    # Install the universal tool connector (used by the diffractui Tools tab to
    # wire a baked CLI's credentials to the agent: host-side OpenShell provider +
    # egress allow-list; the secret never enters the sandbox). See
    # scripts/diffract-tool-connect.sh. Also stage the tool registry on a stable
    # host path so the Tools API can read it regardless of cwd.
    if [ -f "$PROJECT_ROOT/scripts/diffract-tool-connect.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-tool-connect.sh" /usr/local/bin/diffract-tool-connect.sh \
            && print_success "  installed diffract-tool-connect.sh"
    fi
    if [ -f "$PROJECT_ROOT/scripts/diffract-tool-add.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-tool-add.sh" /usr/local/bin/diffract-tool-add.sh \
            && print_success "  installed diffract-tool-add.sh"
    fi
    # Install the gateway watchdog — keeps the agent chat backend (8642) alive by
    # health-checking it and recovering a crashed gateway / dead forward. Runs as
    # its own systemd service (defined below) so every deployment is self-healing.
    if [ -f "$PROJECT_ROOT/scripts/diffract-gateway-watchdog.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-gateway-watchdog.sh" /usr/local/bin/diffract-gateway-watchdog.sh \
            && print_success "  installed diffract-gateway-watchdog.sh"
    fi
    # Config guard: the hermes dashboard runs as root and rewrites the agent
    # config.yaml root-owned; the sandbox-user gateway then cannot read it and
    # falls back to a no-inference default (HTTP 500 No inference provider). This
    # guard keeps config.yaml group=sandbox (setgid + chgrp) so it stays readable.
    if [ -f "$PROJECT_ROOT/scripts/diffract-config-guard.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-config-guard.sh" /usr/local/bin/diffract-config-guard.sh \
            && print_success "  installed diffract-config-guard.sh"
    fi
    if [ -f "$PROJECT_ROOT/NemoClaw/agents/hermes/diffract-tools.json" ]; then
        mkdir -p /usr/local/share/diffract \
            && install -m 0644 "$PROJECT_ROOT/NemoClaw/agents/hermes/diffract-tools.json" /usr/local/share/diffract/diffract-tools.json
    fi

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

# Keep the agent identity on-brand. If the sandbox image still ships an older
# (Hermes/NemoClaw) SOUL.md, replace it with the deployment's canonical Diffract
# SOUL.md (staged on the host by setup.sh's branding step). Self-deactivates once a
# rebuilt image bakes the Diffract identity (no old markers -> no overwrite) and
# leaves a genuinely custom SOUL.md alone. SOUL.md is a data file (the agent's
# primary identity), safe to overlay live -- unlike the version-skew-sensitive
# Python/TUI. Canonical source: NemoClaw/agents/hermes/SOUL.md.
SOUL_SRC=/usr/local/lib/hermes-agent/SOUL.md
if [ -f "$SOUL_SRC" ] && docker exec $CONTAINER_ID sh -c '[ ! -f /sandbox/.hermes/SOUL.md ] || grep -qiE "NemoClaw|OpenShell sandbox|Hermes Agent|helpful AI assistant running" /sandbox/.hermes/SOUL.md' 2>/dev/null; then
    docker cp "$SOUL_SRC" $CONTAINER_ID:/sandbox/.hermes/SOUL.md 2>/dev/null \
      && docker exec $CONTAINER_ID sh -c 'chown sandbox:sandbox /sandbox/.hermes/SOUL.md 2>/dev/null; chmod 0644 /sandbox/.hermes/SOUL.md' 2>/dev/null \
      && echo "Applied Diffract agent identity (SOUL.md) to sandbox"
fi

# Restore the user's working files into a freshly-created sandbox. This is a
# no-op on a returning container (marker-gated, once per container lifetime), so
# it never clobbers a running sandbox's newer files. See diffract-persist.sh.
if [ -x /usr/local/bin/diffract-persist.sh ]; then
    /usr/local/bin/diffract-persist.sh restore "$SANDBOX_NAME" || true
fi

echo "Finding container IP..."
CONTAINER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $CONTAINER_ID)

# --- Port 9119 (agent dashboard + chat WebSocket) ---
# The chat WS guard (_ws_client_is_allowed in web_server.py) only accepts a LOOPBACK
# client peer (a DNS-rebinding defence). Two naive transports both fail behind Caddy:
#   * a plain host socat presents the docker BRIDGE IP as the peer -> WS upgrade 403;
#   * an `openshell forward` / ssh -L tunnel lands in the sandbox WORKLOAD netns, but the
#     dashboard is `docker exec`-ed into the CONTAINER netns -> the tunnel 502s.
# Fix (transport only -- no source or image change): re-originate the connection from the
# container's OWN loopback via an in-container socat hop, so the dashboard sees 127.0.0.1
# as the peer and accepts the upgrade. Chain:
#     127.0.0.1:9119 (host) -> $CONTAINER_IP:9118 (bridge) -> 127.0.0.1:9119 (in container)
# NOTE: this neutralises the peer check in effect (same as relaxing it would) -- behind a
# reverse proxy the peer is always the proxy, so the anti-rebinding intent cannot be
# preserved by any transport. The real remaining gates are the per-session token
# (?token=) and the Origin check. The host listener is bound to 127.0.0.1 (Caddy reaches
# it via loopback) so 9119 is never exposed on a public/other interface.
HOP_PORT=9118
ensure_9119_forward() {
    if ! docker exec $CONTAINER_ID ss -ltn 2>/dev/null | grep -q ":$HOP_PORT"; then
        docker exec $CONTAINER_ID sh -c "pkill -f 'TCP-LISTEN:$HOP_PORT' 2>/dev/null; true" || true
        docker exec -d $CONTAINER_ID socat TCP-LISTEN:$HOP_PORT,fork,reuseaddr TCP:127.0.0.1:9119 || true
    fi
    if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:9119'; then
        socat TCP-LISTEN:9119,bind=127.0.0.1,fork,reuseaddr TCP:$CONTAINER_IP:$HOP_PORT &
    fi
}
# --- Port 8642 (agent OpenAI-compatible gateway -- the chat backend) ---
# The gateway is started via nemoclaw-start over the openshell ssh session, so its
# api_server listens in the sandbox WORKLOAD netns (127.0.0.1:18642, fronted by an
# in-sandbox socat on :8642), NOT the container bridge netns. A host socat to the
# bridge IP cannot reach it -> Caddy /v1/* returns 502 and the chat UI fails. Use an
# openshell loopback (ssh -L) forward, which lands in the workload netns where the
# gateway lives. (Same netns split as 9119, opposite direction: 9119's dashboard is
# in the CONTAINER netns, 8642's gateway is in the WORKLOAD netns.)
ensure_8642_forward() {
    if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:8642'; then
        openshell forward stop 8642 "$SANDBOX_NAME" >/dev/null 2>&1 || true
        pkill -f -- '-L 127.0.0.1:8642:127.0.0.1:8642' 2>/dev/null || true
        openshell forward start --background 8642 "$SANDBOX_NAME" >/dev/null 2>&1 || true
    fi
}
cleanup_fwd() {
    kill $KEEPALIVE_PID 2>/dev/null || true
    pkill -f 'TCP-LISTEN:9119,bind=127.0.0.1' 2>/dev/null || true
    openshell forward stop 8642 "$SANDBOX_NAME" >/dev/null 2>&1 || true
    pkill -f -- '-L 127.0.0.1:8642:127.0.0.1:8642' 2>/dev/null || true
    docker exec $CONTAINER_ID sh -c "pkill -f 'TCP-LISTEN:$HOP_PORT' 2>/dev/null; true" >/dev/null 2>&1 || true
    docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --stop || true
}
echo "Starting loopback-reorigination forwarder on port 9119 (hop via container :$HOP_PORT)..."
ensure_9119_forward
# End-to-end keepalive: HTTP and WS share the hop, so a 2xx on 9119 proves the loopback
# origination (hence the WS peer) is live. Rebuild the hop if the real path stops answering.
( i=0; while true; do sleep 15; curl -sf --max-time 5 -o /dev/null http://127.0.0.1:9119/agent/ 2>/dev/null || ensure_9119_forward; ensure_8642_forward; i=$((i+1)); if [ "$((i % 20))" -eq 0 ] && [ -x /usr/local/bin/diffract-persist.sh ]; then /usr/local/bin/diffract-persist.sh backup-if-ready "$SANDBOX_NAME" >/dev/null 2>&1 || true; fi; done ) &
KEEPALIVE_PID=$!

echo "Starting loopback gateway forward (openshell ssh -L) on port 8642..."
ensure_8642_forward

# Stop any stale dashboard inside the container so the fresh one can bind 9119,
# and make sure both the dashboard and the socat forwarders are torn down when
# this service stops/restarts.
docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --stop || true
trap cleanup_fwd EXIT

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
# Ensure the embedded TUI chat's PTY dependency is present. The base image ships only
# the "messaging web" uv extras (Dockerfile.base HERMES_UV_EXTRAS), so the [pty] extra
# (ptyprocess, used by hermes_cli/pty_bridge.py) is absent until a base rebuild includes
# it -- without it the chat WS connects but immediately sends "Chat unavailable". Install
# it here (presence-checked + idempotent; a no-op once the image carries pty) so chat
# works on every (re)deploy without a rebuild.
docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python -c "import ptyprocess" 2>/dev/null \
  || docker exec $CONTAINER_ID /opt/hermes/.venv/bin/python -m pip install "ptyprocess==0.7.0" || true

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

    # Create the gateway watchdog service (keeps the chat backend self-healing).
    cat <<EOF > /etc/systemd/system/diffract-gateway-watchdog.service
[Unit]
Description=Diffract Gateway Watchdog (agent chat backend self-heal)
After=network.target docker.service sandbox-port-forwarder.service
Wants=docker.service

[Service]
Type=simple
User=root
Environment=PATH=$PATH
ExecStart=/usr/local/bin/diffract-gateway-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    # Config guard service (keep the Hermes config.yaml readable by the gateway).
    cat <<EOF > /etc/systemd/system/diffract-config-guard.service
[Unit]
Description=Diffract Config Guard (keep Hermes config.yaml readable by the sandbox gateway)
After=docker.service
Wants=docker.service

[Service]
Type=simple
User=root
Environment=PATH=$PATH
ExecStart=/usr/local/bin/diffract-config-guard.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable sandbox-port-forwarder.service
    systemctl restart sandbox-port-forwarder.service
    if [ -x /usr/local/bin/diffract-gateway-watchdog.sh ]; then
        systemctl enable diffract-gateway-watchdog.service
        systemctl restart diffract-gateway-watchdog.service
    fi
    if [ -x /usr/local/bin/diffract-config-guard.sh ]; then
        systemctl enable diffract-config-guard.service
        systemctl restart diffract-config-guard.service
    fi
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
                # The agent gateway's api_server rejects requests carrying a browser
                # Origin/Referer (DNS-rebinding/CSRF defence) and its allowlist does not
                # include the public host -> 403, which breaks the same-origin chat UI.
                # Strip them here so the chat works; Caddy (a trusted reverse proxy)
                # vouches for the request, and cross-origin reads are still blocked by
                # the browser's CORS (the gateway sends no Access-Control-Allow-Origin).
                header_up -Origin
                header_up -Referer
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
                # The agent gateway's api_server rejects requests carrying a browser
                # Origin/Referer (DNS-rebinding/CSRF defence) and its allowlist does not
                # include the public host -> 403, which breaks the same-origin chat UI.
                # Strip them here so the chat works; Caddy (a trusted reverse proxy)
                # vouches for the request, and cross-origin reads are still blocked by
                # the browser's CORS (the gateway sends no Access-Control-Allow-Origin).
                header_up -Origin
                header_up -Referer
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
