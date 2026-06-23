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

for path in "${NVM_DIR:-}/nvm.sh" "$HOME/.nvm/nvm.sh" "/root/.nvm/nvm.sh" "/home/ubuntu/.nvm/nvm.sh" "/home/debian/.nvm/nvm.sh"; do
    if [ -n "$path" ] && [ -s "$path" ]; then
        print_warning "Loading NVM from $path..."
        export NVM_DIR="$(dirname "$path")"
        . "$path"
        NVM_FOUND=true
        break
    fi
done

# A fresh VPS often ships Node 18 (or none), but the CLI build requires Node 22
# (npm@latest needs Node >= 20.17/22.9). If NVM is missing, install it so setup.sh
# can pin Node 22 itself — this makes setup.sh self-sufficient; install.sh is a
# convenience, not a prerequisite.
if [ "$NVM_FOUND" = false ]; then
    print_warning "NVM not found — installing NVM to pin Node 22 (current node: $(command -v node >/dev/null 2>&1 && node -v || echo none))..."
    export NVM_DIR="$HOME/.nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash || \
        print_warning "NVM install script failed (offline?); will fall back to system Node."
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        . "$NVM_DIR/nvm.sh"
        NVM_FOUND=true
    fi
fi

if [ "$NVM_FOUND" = true ]; then
    print_warning "Ensuring Node v22 is installed and active..."
    nvm install 22
    nvm use 22
    print_success "Using Node version: $(node -v)"
elif command -v node &> /dev/null; then
    # No NVM (e.g. offline). Use system Node, but refuse versions too old to build.
    NODE_VER="$(node -v)"
    NODE_MAJOR="$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')"
    print_warning "NVM unavailable; using system Node $NODE_VER"
    if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
        print_error "Node $NODE_VER is too old — the CLI build needs Node >= 20 (22 recommended)."
        print_error "Install Node 22 (e.g. via NVM) and re-run, or run install.sh which handles it."
        exit 1
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
    # Install OpenShell pinned to the blueprint's max_openshell_version — the single
    # source of truth NemoClaw onboard also enforces (nemoclaw-blueprint/blueprint.yaml).
    # Prefer the repo's mirror-first installer (re-hosted, checksum-verified OpenShell on
    # the Diffract repo; NVIDIA upstream is its own automatic fallback) so a fresh VPS does
    # not depend on upstream release availability. If the repo installer is missing or
    # fails, fall back to the upstream installer (still pinned).
    _OS_BLUEPRINT="NemoClaw/nemoclaw-blueprint/blueprint.yaml"
    _OS_PIN="$(grep -oE 'max_openshell_version:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' "$_OS_BLUEPRINT" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    _OS_INSTALLER="NemoClaw/scripts/install-openshell.sh"
    if [ -n "$_OS_PIN" ] && [ -f "$_OS_INSTALLER" ]; then
        # The repo installer needs `strings` (binutils) for its capability check.
        command -v strings >/dev/null 2>&1 || apt-get install -y -qq binutils >/dev/null 2>&1 || true
        print_warning "Installing OpenShell v${_OS_PIN} via the mirror-first installer (pinned to blueprint)..."
        if ! NEMOCLAW_OPENSHELL_PIN_VERSION="$_OS_PIN" NEMOCLAW_OPENSHELL_MAX_VERSION="$_OS_PIN" bash "$_OS_INSTALLER"; then
            print_warning "Mirror-first installer failed — falling back to the upstream OpenShell installer..."
            curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION="v${_OS_PIN}" sh
        fi
    elif [ -n "$_OS_PIN" ]; then
        print_warning "Installing OpenShell v${_OS_PIN} (pinned to blueprint; repo installer not found)..."
        curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION="v${_OS_PIN}" sh
    else
        print_warning "Installing OpenShell (latest — blueprint pin not found)..."
        curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
    fi
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
# Non-fatal: the npm bundled with Node 22 is sufficient. A self-update can fail on
# a too-old Node (npm@latest needs Node >= 20.17/22.9); don't abort the install.
npm install -g npm@latest || print_warning "npm self-update skipped (bundled npm is fine)"
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

# Step 5.5: Build the Hermes sandbox base image from the LOCAL Dockerfile.base.
#
# WHY THIS IS REQUIRED (do not remove): `nemoclaw onboard` resolves the base image
# via NemoClaw/src/lib/sandbox-base-image.ts. On a fresh clone sitting on
# origin/main, baseImageInputsChangedSinceMain() returns false, so the resolver
# PULLS ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest — NVIDIA's UPSTREAM
# image, which does NOT contain the Diffract additions baked into our
# Dockerfile.base. Most importantly it lacks the `mcp` Python SDK (mcp==1.26.0),
# without which every HTTP MCP server (Stitch, Zapier, …) fails in chat with
# "mcp.client.streamable_http is not available" — and the uv venv has no pip, so it
# cannot be added at runtime. It also predates the pty/Chromium layers.
#
# Building the image locally under the SAME :latest tag makes the resolver's
# `docker image inspect` succeed and SKIP the remote pull (see resolvePulledCandidate),
# so every fresh deploy gets a correct base image without a manual
# `nemoclaw <sandbox> rebuild`. Idempotent: Docker's layer cache makes re-runs fast;
# the first build takes several minutes. Mirrors dockerBuild() in the CLI exactly
# (DOCKER_BUILDKIT=1; Dockerfile.base needs BuildKit for RUN --mount).
print_header "Building Hermes Sandbox Base Image (bakes in mcp / pty / chromium)"
HERMES_BASE_DOCKERFILE="$NEMOCLAW_DIR/agents/hermes/Dockerfile.base"
HERMES_BASE_IMAGE="ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest"
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 && [ -f "$HERMES_BASE_DOCKERFILE" ]; then
    # Dockerfile.base needs BuildKit (RUN --mount=type=bind). Ubuntu's docker.io
    # package ships NO buildx plugin, so `DOCKER_BUILDKIT=1 docker build` aborts with
    # "buildx component is missing". Ensure the buildx CLI plugin first (idempotent;
    # a no-op when Docker was installed from Docker's own repo / get.docker.com).
    if ! docker buildx version >/dev/null 2>&1; then
        print_warning "Docker buildx plugin missing — installing it (Dockerfile.base needs BuildKit)..."
        BUILDX_VER="v0.19.3"
        BUILDX_ARCH="$(uname -m)"; case "$BUILDX_ARCH" in x86_64) BUILDX_ARCH=amd64;; aarch64|arm64) BUILDX_ARCH=arm64;; esac
        mkdir -p /usr/local/lib/docker/cli-plugins
        if curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VER}/buildx-${BUILDX_VER}.linux-${BUILDX_ARCH}" \
                -o /usr/local/lib/docker/cli-plugins/docker-buildx 2>/dev/null; then
            chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
            docker buildx version >/dev/null 2>&1 && print_success "  buildx installed" \
                || print_warning "  buildx still unavailable after install"
        else
            print_warning "  buildx download failed (offline?) — base image build may fail"
        fi
    fi
    print_warning "Building $HERMES_BASE_IMAGE from local Dockerfile.base (first run: several minutes)..."
    if DOCKER_BUILDKIT=1 docker build -f "$HERMES_BASE_DOCKERFILE" -t "$HERMES_BASE_IMAGE" "$NEMOCLAW_DIR"; then
        print_success "Hermes base image built locally — onboard will use THIS (mcp/pty/chromium baked in), not the stale upstream image"
    else
        print_warning "Base image build FAILED — onboard would fall back to the upstream image and MCP-in-chat may not work."
        print_warning "Re-run setup.sh, or after onboarding run: nemoclaw <sandbox> rebuild --yes"
    fi
else
    print_warning "Docker unavailable or Dockerfile.base missing — skipping base image build."
    print_warning "MCP-in-chat needs it; once Docker is up, re-run setup.sh (or 'nemoclaw <sandbox> rebuild')."
fi

# Step 5.7: Stage the host Hermes checkout at /usr/local/lib/hermes-agent.
# The port-forwarder service uses this as its WorkingDirectory AND copies its
# hermes_cli/web_dist into the sandbox; the branding overlay (below) builds that
# web_dist here. Without this dir a fresh box has nothing to chdir to, so
# sandbox-port-forwarder.service crash-loops with status=200/CHDIR and the /agent
# dashboard never comes up. Stage only when missing (don't clobber an existing
# checkout — resolve_hermes_dir / _overlay_host then keep it updated).
HOST_HERMES_DIR="/usr/local/lib/hermes-agent"
if [ -d "$LOCAL_HERMES_DIR" ] && [ ! -d "$HOST_HERMES_DIR/hermes_cli" ]; then
    print_warning "Staging host Hermes checkout at $HOST_HERMES_DIR (port-forwarder workdir + web_dist source)..."
    mkdir -p "$HOST_HERMES_DIR"
    cp -a "$LOCAL_HERMES_DIR/." "$HOST_HERMES_DIR/"
    print_success "Host Hermes staged at $HOST_HERMES_DIR"
fi

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
# CRITICAL: only kill the web-server process on stop/restart — NOT the whole
# cgroup. A dashboard Deploy spawns `nemoclaw onboard`, which starts the OpenShell
# gateway; that gateway inherits this service's cgroup. With the default
# KillMode=control-group, `systemctl restart diffractui` (e.g. a UI update) would
# SIGKILL the gateway and take the running agent/sandbox down with it. KillMode=process
# leaves those descendants alive so UI restarts never knock out the agent.
KillMode=process
User=root
WorkingDirectory=$UI_DIR
Environment=PATH=$PATH
Environment=PORT=3000
Environment=NODE_ENV=production
Environment=DIFFRACT_PATH=$(which nemoclaw || echo "nemoclaw")
# Hermes is the ONLY agent Diffract ships. Force it for every onboard the
# dashboard spawns: resolveAgentName honors NEMOCLAW_AGENT, so even a fresh /
# session-less onboard can never silently fall back to OpenClaw.
Environment=NEMOCLAW_AGENT=hermes
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
    # Install the universal tool sync (registry-driven). Makes EVERY connected
    # tool usable by the chat agent: lists connected tools for attach-at-create
    # (NEMOCLAW_SANDBOX_EXTRA_PROVIDERS) and applies each tool's egress from the
    # registry. The deploy flow calls it so adding any CLI needs no code change.
    if [ -f "$PROJECT_ROOT/scripts/diffract-tool-sync.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-tool-sync.sh" /usr/local/bin/diffract-tool-sync.sh \
            && print_success "  installed diffract-tool-sync.sh"
    fi
    # MCP connectors: diffract-mcp-connect.sh wires one MCP server (token held
    # host-side as an OpenShell provider placeholder); diffract-mcp-sync.sh
    # re-applies connected MCP servers (provider attach + egress + config) at each
    # deploy so the chat agent can use them. Mirrors the tool connect/sync pair.
    if [ -f "$PROJECT_ROOT/scripts/diffract-mcp-connect.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-mcp-connect.sh" /usr/local/bin/diffract-mcp-connect.sh \
            && print_success "  installed diffract-mcp-connect.sh"
    fi
    if [ -f "$PROJECT_ROOT/scripts/diffract-mcp-sync.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-mcp-sync.sh" /usr/local/bin/diffract-mcp-sync.sh \
            && print_success "  installed diffract-mcp-sync.sh"
    fi
    # Install the gateway watchdog — keeps the agent chat backend (8642) alive by
    # health-checking it and recovering a crashed gateway / dead forward. Runs as
    # its own systemd service (defined below) so every deployment is self-healing.
    if [ -f "$PROJECT_ROOT/scripts/diffract-gateway-watchdog.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-gateway-watchdog.sh" /usr/local/bin/diffract-gateway-watchdog.sh \
            && print_success "  installed diffract-gateway-watchdog.sh"
    fi
    # Install the internal-gateway firewall guard. ufw default-deny INPUT can
    # block the container -> host:8080 gRPC the sandbox supervisor needs (the
    # 2026-06-09 outage root cause). This idempotent helper adds the
    # interface-agnostic allow rule; it's invoked at install (below) and by the
    # watchdog's recovery path. See scripts/diffract-ensure-gateway-firewall.sh.
    if [ -f "$PROJECT_ROOT/scripts/diffract-ensure-gateway-firewall.sh" ]; then
        install -m 0755 "$PROJECT_ROOT/scripts/diffract-ensure-gateway-firewall.sh" /usr/local/bin/diffract-ensure-gateway-firewall.sh \
            && print_success "  installed diffract-ensure-gateway-firewall.sh"
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
    # FUNCTIONAL probe, not a port-bound check: a stale openshell ssh -L forward
    # (left pointing at a destroyed/recreated sandbox-id) keeps :8642 BOUND while
    # the gateway behind it is gone, so the old `ss | grep :8642` guard never
    # rebuilt it and chat silently returned 000 until a manual service restart.
    # Probe the gateway itself (cheap, static /v1/models — no inference); on
    # failure tear down ANY :8642 tunnel and rebuild against the CURRENT default
    # sandbox, re-read fresh (the sandbox-id changes on --recreate-sandbox). The
    # -L substring is constant across sandbox-ids, so the pkill matches a stale
    # tunnel regardless of which sandbox it points at.
    if curl -sf --max-time 5 -o /dev/null http://127.0.0.1:8642/v1/models 2>/dev/null; then
        return 0
    fi
    local cur_sb
    cur_sb="$(jq -r '.defaultSandbox' ~/.nemoclaw/sandboxes.json 2>/dev/null)"
    if [ -z "$cur_sb" ] || [ "$cur_sb" = "null" ]; then
        cur_sb="$SANDBOX_NAME"
    fi
    openshell forward stop 8642 "$cur_sb" >/dev/null 2>&1 || true
    openshell forward stop 8642 "$SANDBOX_NAME" >/dev/null 2>&1 || true
    pkill -f -- '-L 127.0.0.1:8642:127.0.0.1:8642' 2>/dev/null || true
    openshell forward start --background 8642 "$cur_sb" >/dev/null 2>&1 || true
    return 0
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
# HOME=/sandbox is REQUIRED: the dashboard runs as the sandbox user, but without an
# explicit HOME it inherits /root (unreadable by sandbox). Path.home() then points at
# /root and toolset enumeration's (Path.home()/".modal.toml").exists() raises
# PermissionError instead of returning False -> /api/tools/toolsets 500 -> the Skills
# page (Promise.all of skills+toolsets) renders blank. Pinning HOME=/sandbox fixes it.
docker exec -u sandbox -e HOME=/sandbox -e HERMES_WEB_DIST=/opt/hermes/web_dist $CONTAINER_ID \
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
# Force Hermes for any recover/onboard the watchdog triggers (never OpenClaw).
Environment=NEMOCLAW_AGENT=hermes
ExecStart=/usr/local/bin/diffract-gateway-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    # Default EVERY onboard on this box to Hermes — including a manual/CLI
    # `nemoclaw onboard` run in a root shell (resolveAgentName: flag > env >
    # session > openclaw). The systemd units above set it for the dashboard +
    # watchdog; /etc/environment covers login shells. Idempotent.
    if ! grep -q '^NEMOCLAW_AGENT=' /etc/environment 2>/dev/null; then
        echo 'NEMOCLAW_AGENT=hermes' >> /etc/environment
    fi

    systemctl daemon-reload
    systemctl enable sandbox-port-forwarder.service
    systemctl restart sandbox-port-forwarder.service
    if [ -x /usr/local/bin/diffract-gateway-watchdog.sh ]; then
        systemctl enable diffract-gateway-watchdog.service
        systemctl restart diffract-gateway-watchdog.service
    fi
    # Pre-emptively allow the internal container -> gateway gRPC path so that if
    # ufw is (or later becomes) active with a default-deny policy, it can't
    # silently wedge the sandbox supervisor. `ufw allow` persists even while ufw
    # is inactive, so this protects future reboots/toggles too. No-op without ufw.
    if [ -x /usr/local/bin/diffract-ensure-gateway-firewall.sh ]; then
        /usr/local/bin/diffract-ensure-gateway-firewall.sh \
            && print_success "  internal gateway firewall rule ensured"
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
        print_warning "No domain name argument specified. Serving on port 80 for any host (use the VPS IP)..."
        # ":80" matches ANY Host header on port 80, so this works on a bare IP or
        # any hostname without hardcoding a domain (a fresh client VPS has neither).
        # Pass a domain to setup.sh to get automatic HTTPS instead.
        CADDY_CONFIG=":80 {
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
