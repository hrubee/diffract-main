#!/bin/bash
# Diffract multi-sandbox "fleet" reconciler.
#
# Gives EVERY sandbox its own origin (https://<host>:<listen>) so the operator can
# chat with several sandboxes concurrently. This runs ALONGSIDE the legacy
# sandbox-port-forwarder.service (which keeps the default sandbox on the canonical
# host ports 9119/8642 + the main Caddy site) — this reconciler never touches those
# ports, so if anything here misbehaves the proven default-sandbox chat still works.
#
# Per sandbox it stands up the same two transports the legacy forwarder uses, just on
# per-sandbox host ports allocated from a registry:
#   web (SPA + chat WS): host 127.0.0.1:WEB_i --socat--> CONTAINER_IP_i:FLEET_HOP
#                        --in-container socat--> 127.0.0.1:9119   (loopback re-origination
#                        so web_server.py's _ws_client_is_allowed peer check passes)
#   gw  (/v1 gateway):   openshell forward service <name> --target-port 8642
#                        --local 127.0.0.1:GW_i   (distinct local port per sandbox;
#                        plain `forward start` cannot remap the port)
# then regenerates a per-sandbox Caddy site snippet and reloads Caddy.
#
# The registry /var/lib/diffract/sandbox-ports.json is the single source of truth;
# THIS process is its only writer (allocate on first sight, free when the sandbox is
# gone). diffractui reads it (GET /api/sandboxes) to surface the chat URL.
#
# NOTE: uses a distinct in-container hop port (FLEET_HOP=9128) from the legacy
# forwarder's 9118, so both can run inside the default sandbox's container at once.

set -u

REGISTRY=/var/lib/diffract/sandbox-ports.json
REGISTRY_DIR=$(dirname "$REGISTRY")
CADDY_SNIPPET=/etc/caddy/diffract-sandboxes.caddy
NEMOCLAW_HOME="${NEMOCLAW_HOME:-$HOME/.nemoclaw}"
FLEET_HOP=9128
MAX_SANDBOXES="${DIFFRACT_MAX_SANDBOXES:-4}"
# Port bases (index i in 0..MAX-1): external listen, host web loopback, host gw loopback.
LISTEN_BASE=8443
WEB_BASE=9200
GW_BASE=9300
POLL_INTERVAL="${DIFFRACT_FLEET_POLL:-15}"

mkdir -p "$REGISTRY_DIR"
[ -f "$REGISTRY" ] || echo '{}' > "$REGISTRY"

# Logs go to STDERR (still captured by journald) so they never contaminate the
# stdout of functions whose output is captured via $(...), e.g. alloc_ports.
log() { echo "[fleet] $*" >&2; }

# --- registry helpers (jq, flock-guarded) -----------------------------------
# All reads/writes go through flock on the registry so a concurrent reader (the
# Node API) never sees a half-written file.
reg_read() { flock -s "$REGISTRY" cat "$REGISTRY" 2>/dev/null || echo '{}'; }
reg_write() {
    # stdin = new JSON; written atomically.
    local tmp="${REGISTRY}.tmp.$$"
    cat > "$tmp" && flock -x "$REGISTRY" mv -f "$tmp" "$REGISTRY"
}

# Allocate (idempotent) a port triple for a sandbox name. Echoes "LISTEN WEB GW"
# or nothing if at cap and the name is new. Persists to the registry.
alloc_ports() {
    local name="$1"
    local reg existing idx used
    reg=$(reg_read)
    existing=$(echo "$reg" | jq -r --arg n "$name" '.[$n] // empty | "\(.listen) \(.web) \(.gw)"' 2>/dev/null)
    if [ -n "$existing" ]; then
        echo "$existing"
        return 0
    fi
    # Find the lowest free index 0..MAX-1.
    used=$(echo "$reg" | jq -r '.[].idx' 2>/dev/null)
    idx=""
    local i
    for ((i=0; i<MAX_SANDBOXES; i++)); do
        if ! echo "$used" | grep -qx "$i"; then idx=$i; break; fi
    done
    if [ -z "$idx" ]; then
        log "at cap ($MAX_SANDBOXES); not allocating ports for new sandbox '$name'"
        return 1
    fi
    local listen=$((LISTEN_BASE + idx)) web=$((WEB_BASE + idx)) gw=$((GW_BASE + idx))
    echo "$reg" | jq --arg n "$name" \
        --argjson l "$listen" --argjson w "$web" --argjson g "$gw" --argjson x "$idx" \
        '.[$n] = {listen:$l, web:$w, gw:$g, idx:$x}' | reg_write
    log "allocated '$name' -> listen=$listen web=$web gw=$gw (idx=$idx)"
    echo "$listen $web $gw"
}

free_ports() {
    local name="$1" reg
    reg=$(reg_read)
    echo "$reg" | jq --arg n "$name" 'del(.[$n])' | reg_write
    log "freed ports for removed sandbox '$name'"
}

# --- transport helpers ------------------------------------------------------
# Ensure the Hermes dashboard (the SPA + chat WS server) is actually RUNNING on
# 127.0.0.1:9119 inside the sandbox container. The legacy forwarder only launches
# it for the DEFAULT sandbox, so for every other sandbox the fleet must start its
# own — otherwise the web forward below hits a dead port. Mirrors the legacy
# launch (web_dist copy + ptyprocess for --tui chat + dashboard on 0.0.0.0).
# Guarded by an in-container :9119 listen check, so it's a no-op for the default
# sandbox (legacy already serves it) and idempotent on every poll.
ensure_dashboard() {
    # $1 container id
    local cid="$1"
    if docker exec "$cid" ss -ltn 2>/dev/null | grep -q ':9119'; then
        return 0
    fi
    # Stage the built UI (same source the legacy forwarder copies for default).
    docker exec "$cid" mkdir -p /opt/hermes/web_dist >/dev/null 2>&1 || true
    docker cp /usr/local/lib/hermes-agent/hermes_cli/web_dist/. "$cid":/opt/hermes/web_dist/ >/dev/null 2>&1 || true
    # The embedded TUI chat needs ptyprocess; base image may lack it (idempotent).
    docker exec "$cid" /opt/hermes/.venv/bin/python -c "import ptyprocess" >/dev/null 2>&1 \
        || docker exec "$cid" /opt/hermes/.venv/bin/python -m pip install "ptyprocess==0.7.0" >/dev/null 2>&1 || true
    # Launch detached on 0.0.0.0 (the 0.0.0.0 bind neutralizes the WS Host/Origin
    # check, so a non-standard-port origin is accepted). Sources the per-sandbox
    # OpenShell proxy env so the agent's inference resolves.
    docker exec -d -u sandbox -e HOME=/sandbox -e HERMES_WEB_DIST=/opt/hermes/web_dist "$cid" \
        bash -c '. /tmp/nemoclaw-proxy-env.sh 2>/dev/null; exec /opt/hermes/.venv/bin/python /usr/local/bin/hermes dashboard --host 0.0.0.0 --skip-build --insecure --tui' \
        >/dev/null 2>&1 || true
}

ensure_web_forward() {
    # $1 name, $2 container id, $3 container ip, $4 host web port
    local cid="$2" cip="$3" web="$4"
    # In-container re-origination hop on FLEET_HOP -> container loopback :9119.
    if ! docker exec "$cid" ss -ltn 2>/dev/null | grep -q ":$FLEET_HOP"; then
        docker exec -d "$cid" socat TCP-LISTEN:$FLEET_HOP,fork,reuseaddr TCP:127.0.0.1:9119 >/dev/null 2>&1 || true
    fi
    # Host listener WEB_i -> container bridge :FLEET_HOP. Exact-match the local
    # addr:port (awk) so e.g. :9200 is not considered "up" by a stray :92001.
    if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qx "127.0.0.1:$web"; then
        socat TCP-LISTEN:$web,bind=127.0.0.1,fork,reuseaddr TCP:"$cip":$FLEET_HOP >/dev/null 2>&1 &
    fi
}

ensure_gw_forward() {
    # $1 name, $2 host gw port. Functional probe; rebuild the gRPC service-forward
    # against the live sandbox on failure (mirrors the legacy 8642 probe).
    local name="$1" gw="$2"
    if curl -sf --max-time 5 -o /dev/null "http://127.0.0.1:$gw/v1/models" 2>/dev/null; then
        return 0
    fi
    pkill -f -- "--local 127.0.0.1:$gw" 2>/dev/null || true
    # `forward service` has no --background flag; detach it ourselves.
    nohup openshell forward service "$name" --target-port 8642 --local "127.0.0.1:$gw" \
        >/dev/null 2>&1 &
}

teardown_sandbox() {
    # $1 name, $2 host web port, $3 host gw port
    pkill -f "TCP-LISTEN:$2,bind=127.0.0.1" 2>/dev/null || true
    pkill -f -- "--local 127.0.0.1:$3" 2>/dev/null || true
}

# --- Caddy snippet generation ----------------------------------------------
# Per-sandbox PATH routes, served on the SINGLE existing origin (no extra ports /
# certs). Each sandbox lives under /<name>/agent/. The Hermes SPA is prefix-aware
# (it reads window.__HERMES_BASE_PATH__, injected from X-Forwarded-Prefix), so once
# served with prefix /<name>/agent it routes ALL its calls (assets, /api/ws, and
# /v1 after the ChatPage fix) under that prefix. We strip the prefix before the
# upstream: /<name>/agent/v1/* -> the sandbox gateway (sees /v1/*), everything else
# under /<name>/agent/* -> the sandbox web server (sees /...). This snippet is
# imported INSIDE the main Caddy site block (so these are siblings of the existing
# handles); Caddy orders `handle` by path specificity, so /<name>/agent/v1 wins
# over /<name>/agent which wins over the site's catch-all.
regen_caddy() {
    local reg tmp changed
    reg=$(reg_read)
    tmp=$(mktemp)
    echo "# AUTO-GENERATED by diffract-sandbox-fleet.sh — do not edit." > "$tmp"
    echo "# Imported INSIDE the main Caddy site block." >> "$tmp"
    while IFS=$'\t' read -r name web gw; do
        [ -z "$name" ] && continue
        cat >> "$tmp" <<CADDY
    redir /$name/agent /$name/agent/
    handle /$name/agent/v1/* {
        uri strip_prefix /$name/agent
        reverse_proxy 127.0.0.1:$gw {
            header_up Host {upstream_hostport}
            header_up -Origin
            header_up -Referer
        }
    }
    handle /$name/agent/* {
        uri strip_prefix /$name/agent
        reverse_proxy 127.0.0.1:$web {
            header_up Host {upstream_hostport}
            header_up X-Forwarded-Prefix /$name/agent
        }
    }
CADDY
    done < <(echo "$reg" | jq -r 'to_entries[] | select(.value.running == true) | [.key, .value.web, .value.gw] | @tsv')

    if ! cmp -s "$tmp" "$CADDY_SNIPPET" 2>/dev/null; then
        mv -f "$tmp" "$CADDY_SNIPPET"
        changed=1
    else
        rm -f "$tmp"
    fi
    if [ "${changed:-0}" = "1" ]; then
        log "caddy snippet changed; reloading"
        caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
            || systemctl reload caddy >/dev/null 2>&1 || true
    fi
}

# Mark which registry entries are currently running (used by regen_caddy so a site
# is only published while its sandbox is up).
set_running() {
    local name="$1" val="$2" reg
    reg=$(reg_read)
    echo "$reg" | jq --arg n "$name" --argjson r "$val" \
        'if .[$n] then .[$n].running = $r else . end' | reg_write
}

# --- reconcile loop ---------------------------------------------------------
reconcile() {
    local list names reg known
    list=$(nemoclaw list --json 2>/dev/null) || return 0
    names=$(echo "$list" | jq -r '.sandboxes[].name' 2>/dev/null)
    [ -z "$names" ] && return 0

    # Free registry entries whose sandbox no longer exists.
    reg=$(reg_read)
    known=$(echo "$reg" | jq -r 'keys[]' 2>/dev/null)
    local k
    for k in $known; do
        if ! echo "$names" | grep -qx "$k"; then
            local w g
            w=$(echo "$reg" | jq -r --arg n "$k" '.[$n].web // empty')
            g=$(echo "$reg" | jq -r --arg n "$k" '.[$n].gw // empty')
            teardown_sandbox "$k" "$w" "$g"
            free_ports "$k"
        fi
    done

    # Ensure forwards for every running sandbox.
    local name cid cip ports listen web gw
    for name in $names; do
        cid=$(docker ps -q -f "name=openshell-${name}" 2>/dev/null)
        if [ -z "$cid" ]; then
            set_running "$name" false
            continue
        fi
        ports=$(alloc_ports "$name") || continue
        read -r listen web gw <<< "$ports"
        [ -z "${gw:-}" ] && continue
        cip=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid" 2>/dev/null)
        [ -z "$cip" ] && continue
        ensure_dashboard "$cid"
        ensure_web_forward "$name" "$cid" "$cip" "$web"
        ensure_gw_forward "$name" "$gw"
        set_running "$name" true
    done

    regen_caddy
}

# Only run the supervised poll loop when executed directly (systemd). When this
# file is sourced (e.g. by a test harness) the helpers are defined but the loop is
# skipped, so allocation/Caddy-gen logic can be exercised without docker/openshell.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    log "starting fleet reconciler (max=$MAX_SANDBOXES, hop=$FLEET_HOP, poll=${POLL_INTERVAL}s)"
    while true; do
        reconcile || true
        sleep "$POLL_INTERVAL"
    done
fi
