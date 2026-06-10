#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract gateway watchdog — keeps the agent CHAT BACKEND alive.
#
# Health-checks the OpenAI-compatible gateway on 8642 (the backend that answers
# chat messages) and recovers it when it goes unreachable, so a crashed gateway
# or a dead 8642 forward can't silently 502 every "send" for hours.
#
# Installed + enabled by setup.sh, so EVERY Diffract deployment runs it.
#
# Recovery is least-disruptive, NETNS-SAFE, and capped, so it can never thrash:
#   * gateway daemon UP but 8642 path dead  -> restart sandbox-port-forwarder.
#   * gateway daemon DOWN                    -> `nemoclaw <sb> recover`: re-runs
#     the sandbox-side gateway recovery + re-establishes the forward WITHOUT a
#     `docker restart`. On OpenShell 0.0.57 `docker restart` breaks the container
#     netns and permanently wedges the sandbox (this used to thrash every fresh
#     sandbox during startup). recover relaunches the gateway in-place.
#   * still down after MAX_RECOVERIES        -> ALERT + back off; a wedged gateway
#     needs a manual recreate, which we must NOT do automatically (destructive).
#
# Two anti-thrash guards: a startup grace (don't act while a freshly-created
# sandbox is still binding :8642) and an onboard-in-progress guard (never run
# recover concurrently with a dashboard deploy's onboard — that collision
# corrupts sandbox state).
#
# Tunables via env: DIFFRACT_WATCHDOG_INTERVAL, DIFFRACT_GATEWAY_PORT,
# DIFFRACT_WATCHDOG_FAILS, DIFFRACT_WATCHDOG_MAX_RECOVERIES,
# DIFFRACT_WATCHDOG_STARTUP_GRACE, DIFFRACT_WATCHDOG_ALERT_URL (optional webhook).
# ─────────────────────────────────────────────────────────────────────────
set -u

INTERVAL="${DIFFRACT_WATCHDOG_INTERVAL:-20}"
GATEWAY_PORT="${DIFFRACT_GATEWAY_PORT:-8642}"
FAIL_THRESHOLD="${DIFFRACT_WATCHDOG_FAILS:-2}"
MAX_RECOVERIES="${DIFFRACT_WATCHDOG_MAX_RECOVERIES:-4}"
STARTUP_GRACE="${DIFFRACT_WATCHDOG_STARTUP_GRACE:-240}"
ALERT_URL="${DIFFRACT_WATCHDOG_ALERT_URL:-}"
DOCKER="${DOCKER_PATH:-docker}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
FORWARDER_SERVICE="sandbox-port-forwarder.service"
HEALTH_URL="http://127.0.0.1:${GATEWAY_PORT}/v1/models"
# nemoclaw lives under nvm and is NOT on this unit's minimal PATH — resolve it.
NEMOCLAW="${NEMOCLAW_PATH:-$(command -v nemoclaw 2>/dev/null)}"
[ -z "$NEMOCLAW" ] && NEMOCLAW="$(ls -1 /root/.nvm/versions/node/*/bin/nemoclaw 2>/dev/null | head -1)"
[ -z "$NEMOCLAW" ] && NEMOCLAW="nemoclaw"
GATEWAY_FW_SCRIPT="${DIFFRACT_GATEWAY_FW_SCRIPT:-/usr/local/bin/diffract-ensure-gateway-firewall.sh}"

log() { echo "[gateway-watchdog] $*"; }

ensure_gateway_firewall() {
  [ -x "$GATEWAY_FW_SCRIPT" ] || return 0
  local out
  out="$("$GATEWAY_FW_SCRIPT" 2>/dev/null)"
  [ -n "$out" ] && log "root-cause guard: ${out#\[ensure-gateway-firewall\] }"
  return 0
}

sandbox_name() { jq -r '.defaultSandbox' ~/.nemoclaw/sandboxes.json 2>/dev/null; }

resolve_cid() {
  "$DOCKER" ps -q -f "label=openshell.ai/managed-by=openshell" \
    -f "label=openshell.ai/sandbox-name=$1" 2>/dev/null | head -1
}

gateway_healthy() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$HEALTH_URL" 2>/dev/null)" = "200" ]
}

container_uptime_s() {
  local started; started="$("$DOCKER" inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null)"
  [ -z "$started" ] && { echo 0; return; }
  local s now; s="$(date -d "$started" +%s 2>/dev/null)"; now="$(date +%s)"
  [ -z "$s" ] && { echo 999999; return; }
  echo $(( now - s ))
}

# Match the dashboard deploy's distinctive `onboard --no-gpu` command. Does NOT
# match the persistent `openshell sandbox create --from ... nemoclaw-start`
# session holder (no 'onboard' in its cmdline), so this only fires during a real
# onboard/deploy.
onboard_in_progress() {
  pgrep -f 'onboard --no-gpu' >/dev/null 2>&1
}

alert() {
  log "ALERT: $1"
  [ -n "$ALERT_URL" ] && curl -s -o /dev/null --max-time 8 -X POST "$ALERT_URL" \
    -H "Content-Type: application/json" \
    -d "{\"service\":\"diffract-gateway-watchdog\",\"level\":\"alert\",\"message\":\"$1\"}" 2>/dev/null || true
}

log "started (interval=${INTERVAL}s, port=${GATEWAY_PORT}, fail_threshold=${FAIL_THRESHOLD}, max_recoveries=${MAX_RECOVERIES}, startup_grace=${STARTUP_GRACE}s, nemoclaw=${NEMOCLAW})"

fails=0
recoveries=0
alerted=0

while true; do
  sleep "$INTERVAL"

  sb="$(sandbox_name)"
  { [ -z "$sb" ] || [ "$sb" = "null" ]; } && continue
  cid="$(resolve_cid "$sb")"
  [ -z "$cid" ] && continue

  if gateway_healthy; then
    if [ "$recoveries" -gt 0 ] || [ "$fails" -gt 0 ]; then
      log "gateway healthy again (sandbox=$sb)"
    fi
    fails=0; recoveries=0; alerted=0
    continue
  fi

  # Guard 1: never act while an onboard/deploy is running (collision corrupts state).
  if onboard_in_progress; then
    log "onboard/deploy in progress — deferring recovery (sandbox=$sb)"
    fails=0
    continue
  fi

  # Guard 2: a freshly (re)started sandbox needs time to bind :8642.
  up="$(container_uptime_s "$cid")"
  if [ "$up" -lt "$STARTUP_GRACE" ]; then
    log "sandbox up only ${up}s (< ${STARTUP_GRACE}s grace) — letting it finish starting (sandbox=$sb)"
    fails=0
    continue
  fi

  fails=$((fails + 1))
  [ "$fails" -lt "$FAIL_THRESHOLD" ] && continue

  if [ "$recoveries" -ge "$MAX_RECOVERIES" ]; then
    [ "$alerted" -eq 0 ] && { alert "gateway on '$sb' still down after ${MAX_RECOVERIES} recovery attempts — manual intervention (likely a sandbox recreate) required."; alerted=1; }
    continue
  fi

  recoveries=$((recoveries + 1))

  ensure_gateway_firewall

  if "$DOCKER" exec "$cid" pgrep -f 'gateway run' >/dev/null 2>&1; then
    log "gateway 8642 unreachable but daemon is up (sandbox=$sb) — rebuilding forwards (attempt ${recoveries}/${MAX_RECOVERIES})"
    systemctl restart "$FORWARDER_SERVICE" 2>/dev/null || true
  else
    log "gateway daemon is DOWN (sandbox=$sb) — netns-safe recover via nemoclaw (attempt ${recoveries}/${MAX_RECOVERIES})"
    "$NEMOCLAW" "$sb" recover >/dev/null 2>&1 || true
  fi
  fails=0
done
