#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract gateway watchdog — keeps the agent CHAT BACKEND alive.
#
# Two layers of health, because process-alive != chat-works:
#   1. LIVENESS — the OpenAI-compatible gateway answers GET /v1/models with 200.
#      Catches a crashed gateway or a dead :8642 forward (silent 502 on send).
#   2. CHAT-HEALTH — the gateway is alive but actually returns inference errors
#      (route drift, egress denied, no provider). /v1/models is STATIC and returns
#      200 whenever the process lives, so it is BLIND to this. We detect it with a
#      ZERO-TOKEN scan of NEW lines in the sandbox gateway.log for the known
#      "chat is dead but process is alive" signatures — no model call, no credits.
#      (Opt-in DIFFRACT_WATCHDOG_SYNTH=1 adds a real-completion probe for proactive
#      detection when nobody is chatting; off by default because it burns credits.)
#
# This chat-health layer is the fix for the recurring "no response in chat" that
# survived for hours: the old probe only checked liveness, so a drifted inference
# route (HTTP 400 no-compatible-route) or a create-time egress mismatch (HTTP 403
# connection-not-allowed) left chat dead while the watchdog saw a happy 200.
#
# Installed + enabled by setup.sh, so EVERY Diffract deployment runs it.
#
# Recovery is least-disruptive, NETNS-SAFE, and capped, so it can never thrash.
# Chat-health and liveness are SEPARATE state machines (a logged inference error
# is edge-triggered — one line per sparse human message — so it must be LATCHED,
# not fed through the liveness fail-counter that resets on every quiet window):
#   * gateway ALIVE but chat erroring (403 'connection not allowed by policy')
#       -> ALERT immediately. This is a create-time egress mismatch (e.g. a
#          provider switch); recover provably CANNOT rebind egress — it needs a
#          sandbox RECREATE, which we never do automatically (destructive).
#   * gateway ALIVE but chat erroring (any other signature, e.g. 400 no-route)
#       -> ONE `nemoclaw <sb> recover`. This ONLY fixes the case where the route
#          is correct but the running gateway cached a STALE bundle (e.g. a deploy
#          ran `inference set` without `recover`). It does NOT correct a genuinely
#          drifted route (that needs `inference set <model>`, which the watchdog
#          can't originate safely). If the error persists after the one recover
#          -> ALERT naming the manual fix (inference set + recover, or recreate).
#   * gateway daemon UP but 8642 path dead  -> restart sandbox-port-forwarder.
#   * gateway daemon DOWN                    -> `nemoclaw <sb> recover`: re-runs
#     the sandbox-side gateway recovery + re-establishes the forward WITHOUT a
#     `docker restart`. On OpenShell 0.0.57 `docker restart` breaks the container
#     netns and permanently wedges the sandbox (this used to thrash every fresh
#     sandbox during startup). recover relaunches the gateway in-place.
#   * liveness still down after MAX_RECOVERIES -> ALERT + back off (manual recreate).
#
# Two anti-thrash guards: a startup grace (don't act while a freshly-created
# sandbox is still binding :8642) and an onboard-in-progress guard (never run
# recover concurrently with a dashboard deploy's onboard — that collision
# corrupts sandbox state).
#
# Tunables via env: DIFFRACT_WATCHDOG_INTERVAL, DIFFRACT_GATEWAY_PORT,
# DIFFRACT_WATCHDOG_FAILS, DIFFRACT_WATCHDOG_MAX_RECOVERIES,
# DIFFRACT_WATCHDOG_STARTUP_GRACE, DIFFRACT_WATCHDOG_ALERT_URL (optional webhook),
# DIFFRACT_GATEWAY_LOG (in-sandbox log path), DIFFRACT_WATCHDOG_CHAT_CONFIRM
# (clean intervals after a chat recover before declaring chat restored),
# DIFFRACT_WATCHDOG_SYNTH=1 + DIFFRACT_WATCHDOG_SYNTH_INTERVAL (opt-in
# real-completion probe for proactive detection when nobody is chatting).
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
CHAT_URL="http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions"
# In-sandbox gateway log + the signatures that mean "process alive, chat dead".
# ONLY the two signatures actually OBSERVED in a real sandbox gateway.log are
# matched. The fail-safe property protects against a MISSED match (inert, behaves
# like the old liveness-only watchdog) but NOT a FALSE match (a benign line that
# matches would trigger a live recover), so do not add speculative signatures
# here — verify the exact wording on-box (docker exec <cid> tail /tmp/gateway.log)
# before extending this. Overridable via DIFFRACT_WATCHDOG_INFER_ERR_RE.
GATEWAY_LOG="${DIFFRACT_GATEWAY_LOG:-/tmp/gateway.log}"
INFER_ERR_RE="${DIFFRACT_WATCHDOG_INFER_ERR_RE:-no compatible inference route available|connection not allowed by policy}"
# Opt-in real-completion probe (burns credits) — proactively catches a broken
# route when nobody is chatting. Off by default; log-scan is the zero-token path.
SYNTH_PROBE="${DIFFRACT_WATCHDOG_SYNTH:-0}"
SYNTH_INTERVAL="${DIFFRACT_WATCHDOG_SYNTH_INTERVAL:-900}"
# Clean intervals (no new inference error) required AFTER a chat recover before we
# declare chat restored. Avoids re-recovering a gateway that already healed.
CHAT_CONFIRM_CLEAN="${DIFFRACT_WATCHDOG_CHAT_CONFIRM:-5}"
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

# ── Chat-health (process alive but chat broken) ──────────────────────────────
# Cursor into the in-sandbox gateway.log so we only ever read NEW lines.
LAST_LOG_LINES=0
LOG_BASELINED=0
LAST_CID=""
LAST_SYNTH=0

# Zero-token chat probe: scan only the lines added since the last loop for the
# known inference-failure signatures and put the first match in the global
# MATCH_SIG (empty if none). MUST NOT be called via $(...) — it mutates the global
# log cursor (LAST_LOG_LINES/LOG_BASELINED), which a command-substitution subshell
# would discard. Never calls the model — costs no inference credits. On the first
# sight of a container (or after a log rotation/relaunch) it only re-baselines the
# cursor and matches nothing, so historical errors never trigger a recover.
MATCH_SIG=""
inference_error_match() {
  MATCH_SIG=""
  local cid="$1" total delta
  total="$("$DOCKER" exec "$cid" sh -c "wc -l < '$GATEWAY_LOG' 2>/dev/null" 2>/dev/null | tr -dc '0-9')"
  [ -z "$total" ] && return 0                      # no log yet → nothing to judge
  if [ "$LOG_BASELINED" -eq 0 ]; then              # first sight of this container
    LAST_LOG_LINES="$total"; LOG_BASELINED=1; return 0
  fi
  if [ "$total" -lt "$LAST_LOG_LINES" ]; then      # log rotated/truncated (relaunch)
    LAST_LOG_LINES="$total"; return 0
  fi
  delta=$(( total - LAST_LOG_LINES ))
  LAST_LOG_LINES="$total"
  [ "$delta" -le 0 ] && return 0
  MATCH_SIG="$("$DOCKER" exec "$cid" sh -c "tail -n $delta '$GATEWAY_LOG' 2>/dev/null" 2>/dev/null | grep -Eom1 "$INFER_ERR_RE")"
  return 0
}

# Opt-in real end-to-end completion. Returns 0 iff the gateway produced a normal
# reply. No auth needed (the api_server logs "No API key configured"). Burns one
# tiny completion's worth of credits, so it is gated behind SYNTH_PROBE + a long
# interval. Tests from the HOST :8642 (NOT docker exec — that hits the netns and
# always 000s).
synthetic_chat_ok() {
  local body http
  body="$(curl -s --max-time 30 -w $'\n%{http_code}' \
    -X POST "$CHAT_URL" \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}' 2>/dev/null)"
  http="$(printf '%s' "$body" | tail -1)"
  [ "$http" = "200" ] || return 1
  printf '%s' "$body" | grep -q '"finish_reason"'
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

# Liveness (Domain A) counters.
fails=0
recoveries=0
alerted=0
# Chat-health (Domain B) LATCHED state — independent of the liveness counters
# above, because a logged inference error is edge-triggered (one line per sparse
# human message) and must not be reset by a quiet 20s window.
chat_broken=0          # latched: an inference error was observed, not yet cleared
chat_sig=""            # the matched signature (drives 403-fast-path + alert text)
chat_recover_tried=0   # already did the one bundle-refresh recover this episode
chat_alerted=0         # already alerted for this episode
chat_clean=0           # consecutive clean intervals since the recover

while true; do
  sleep "$INTERVAL"

  sb="$(sandbox_name)"
  { [ -z "$sb" ] || [ "$sb" = "null" ]; } && continue
  cid="$(resolve_cid "$sb")"
  [ -z "$cid" ] && continue

  # Re-baseline the log cursor AND reset chat-health state whenever the container
  # changes (recreate/restart): a new container has a fresh log and is the genuine
  # fix for a create-time egress mismatch, so any prior chat-broken latch is moot.
  if [ "$cid" != "$LAST_CID" ]; then
    LAST_CID="$cid"; LAST_LOG_LINES=0; LOG_BASELINED=0
    chat_broken=0; chat_sig=""; chat_recover_tried=0; chat_alerted=0; chat_clean=0
  fi

  live=0; gateway_healthy && live=1

  # ── Domain B: chat-health (only meaningful when the gateway process is alive).
  # /v1/models is static and returns 200 whenever the process lives, so it is
  # blind to a gateway that is up but returning inference errors. Detect that from
  # the log (zero-token) and, optionally, a real-completion probe (opt-in).
  if [ "$live" -eq 1 ]; then
    inference_error_match "$cid"      # sets MATCH_SIG + advances the log cursor (no subshell!)
    cur_sig="$MATCH_SIG"
    if [ -z "$cur_sig" ] && [ "$SYNTH_PROBE" = "1" ] && [ "$chat_broken" -eq 0 ]; then
      now="$(date +%s)"
      if [ $(( now - LAST_SYNTH )) -ge "$SYNTH_INTERVAL" ]; then
        LAST_SYNTH="$now"
        synthetic_chat_ok || cur_sig="synthetic completion probe failed"
      fi
    fi

    if [ -n "$cur_sig" ]; then
      # A FRESH inference error this interval. Latch, and act on the evidence —
      # acting only on a fresh error (never on silence) so the clean-confirmation
      # window below can't be misread as "still broken".
      [ "$chat_broken" -eq 0 ] && log "chat-health: inference failure on '$sb' (sig: ${cur_sig}) — chat broken behind a live gateway"
      chat_broken=1; chat_sig="$cur_sig"; chat_clean=0

      if onboard_in_progress; then
        log "chat-health: onboard/deploy in progress — deferring (sandbox=$sb)"
      else
        up="$(container_uptime_s "$cid")"
        if [ "$up" -lt "$STARTUP_GRACE" ]; then
          log "chat-health: sandbox up only ${up}s (< ${STARTUP_GRACE}s grace) — deferring (sandbox=$sb)"
        elif printf '%s' "$chat_sig" | grep -q 'connection not allowed by policy'; then
          # 403 egress is bound at sandbox-create; recover provably can't rebind it.
          if [ "$chat_alerted" -eq 0 ]; then
            alert "chat on '$sb' is erroring with a 403 egress denial ('connection not allowed by policy'). This is a create-time provider/egress mismatch — recover cannot fix it; the sandbox must be RECREATED with the intended provider as the active route (onboard --recreate-sandbox). Manual intervention required."
            chat_alerted=1
          fi
        elif [ "$chat_recover_tried" -eq 0 ]; then
          # ONE bundle-refresh recover: only fixes a stale cached bundle (route is
          # correct but the running gateway cached an old one — e.g. a deploy ran
          # `inference set` without `recover`). Does NOT correct a drifted route.
          ensure_gateway_firewall
          log "chat-health: bundle-refresh recover on '$sb' (sig: ${chat_sig})"
          "$NEMOCLAW" "$sb" recover >/dev/null 2>&1 || true
          chat_recover_tried=1; chat_clean=0
          LAST_LOG_LINES=0; LOG_BASELINED=0   # gateway relaunched → re-baseline cursor
        else
          # Error came back AFTER the one recover → genuine route drift or egress
          # mismatch the watchdog can't safely auto-fix (can't originate inference
          # set or a recreate). Alert with the manual fix.
          if [ "$chat_alerted" -eq 0 ]; then
            alert "chat on '$sb' is still erroring after a bundle-refresh recover (sig: ${chat_sig}). Likely a drifted inference route or a create-time egress mismatch. Fix on the box: 'nemoclaw inference set --provider <p> --model <m> --sandbox $sb' then 'nemoclaw $sb recover'; if that doesn't clear it, recreate the sandbox with the intended provider. Manual intervention required."
            chat_alerted=1
          fi
        fi
      fi
    elif [ "$chat_broken" -eq 1 ] && [ "$chat_recover_tried" -eq 1 ]; then
      # No fresh error since the bundle-refresh recover → confirm heal over a clean
      # window (never alert here — silence during confirmation is not "still broken").
      chat_clean=$((chat_clean + 1))
      if [ "$chat_clean" -ge "$CHAT_CONFIRM_CLEAN" ]; then
        log "chat-health: '$sb' clean for ${chat_clean} intervals after recover — chat restored"
        chat_broken=0; chat_sig=""; chat_recover_tried=0; chat_alerted=0; chat_clean=0
      fi
    fi
  fi

  # ── Domain A: liveness. When alive, Domain B above already handled chat-health,
  # so just reset the liveness counters and loop.
  if [ "$live" -eq 1 ]; then
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
