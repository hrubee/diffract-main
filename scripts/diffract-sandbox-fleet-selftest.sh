#!/bin/bash
# Diffract multi-sandbox fleet self-test. Run ON the box after deploying Phase 2
# to prove concurrent per-sandbox chat is actually wired up. Read-only: it probes,
# it never changes state. Exit 0 only if every running sandbox passes.
#
#   sudo /usr/local/bin/diffract-sandbox-fleet-selftest.sh
#
# Checks, per sandbox: registry entry + ports, gateway reachable (:GW/v1/models),
# web/dashboard reachable (:WEB/), and the public per-sandbox origin serves. Plus
# global: the fleet service is active and `caddy validate` passes.

set -u
REGISTRY="${DIFFRACT_PORT_REGISTRY:-/var/lib/diffract/sandbox-ports.json}"
DOMAIN_FILE=/var/lib/diffract/domain
CADDYFILE=/etc/caddy/Caddyfile
fail=0
ok()   { echo "  [ OK ] $*"; }
bad()  { echo "  [FAIL] $*"; fail=1; }
info() { echo "$*"; }

info "== fleet service =="
if systemctl is-active --quiet diffract-sandbox-fleet.service; then
    ok "diffract-sandbox-fleet.service is active"
else
    bad "diffract-sandbox-fleet.service is NOT active (systemctl status diffract-sandbox-fleet)"
fi

info "== caddy config =="
if caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null 2>&1; then
    ok "caddy validate passed ($CADDYFILE + imported per-sandbox snippet)"
else
    bad "caddy validate FAILED — run: caddy validate --config $CADDYFILE"
fi

info "== port registry =="
if [ ! -f "$REGISTRY" ]; then
    bad "registry $REGISTRY missing (fleet hasn't written it yet)"
    echo "RESULT: FAIL"; exit 1
fi
domain=""; [ -f "$DOMAIN_FILE" ] && domain=$(tr -d '[:space:]' < "$DOMAIN_FILE")
count=$(jq 'length' "$REGISTRY" 2>/dev/null || echo 0)
info "  $count sandbox(es) in registry; domain='${domain:-<none/IP>}'"

# Per-sandbox probes.
while IFS=$'\t' read -r name listen web gw running; do
    [ -z "$name" ] && continue
    info "== sandbox: $name (listen=$listen web=$web gw=$gw running=$running) =="
    if [ "$running" != "true" ]; then
        info "  (not marked running — skipping live probes)"
        continue
    fi
    # Gateway: static /v1/models, no inference cost.
    if curl -sf --max-time 6 -o /dev/null "http://127.0.0.1:$gw/v1/models"; then
        ok "gateway reachable on 127.0.0.1:$gw"
    else
        bad "gateway NOT reachable on 127.0.0.1:$gw (openshell forward service down?)"
    fi
    # Web/dashboard loopback.
    if curl -sf --max-time 6 -o /dev/null "http://127.0.0.1:$web/"; then
        ok "dashboard/web reachable on 127.0.0.1:$web"
    else
        bad "web NOT reachable on 127.0.0.1:$web (in-container dashboard or socat hop down?)"
    fi
    # Public per-sandbox origin (through Caddy). -k: the per-port cert may be the
    # domain cert; in IP mode it's plain HTTP.
    if [ -n "$domain" ]; then url="https://127.0.0.1:$listen/"; else url="http://127.0.0.1:$listen/"; fi
    if curl -skf --max-time 8 -o /dev/null "$url"; then
        ok "public origin serves: $url"
    else
        bad "public origin NOT serving: $url (Caddy site / reload issue?)"
    fi
done < <(jq -r 'to_entries[] | [.key, .value.listen, .value.web, .value.gw, (.value.running // false)] | @tsv' "$REGISTRY" 2>/dev/null)

echo
if [ "$fail" = "0" ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit "$fail"
