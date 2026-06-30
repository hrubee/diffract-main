#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP sync — makes every connected MCP server usable by the CHAT agent,
# driven entirely by the host-side connection records (no per-server code).
#
# SECURE MODEL (host-side secret): the real token lives ONLY in an OpenShell
# provider. The records + the sandbox config carry ONLY a ${SECRET_ENV}
# placeholder; OpenShell injects an opaque token at create and the L7 proxy
# resolves it to the real secret at egress (TLS-terminated `rest` endpoints, in
# headers AND query params). The agent never sees the real secret. See
# diffract-mcp-connect.sh and docs/bugs/openshell-egress-attribution-mcp-403.md.
#
# The sandbox config is ephemeral (wiped on recreate), so it is re-applied at each
# deploy from the records written by diffract-mcp-connect.sh:
#
#   diffract-mcp-sync.sh providers          # -> comma-joined provider names for NEMOCLAW_SANDBOX_EXTRA_PROVIDERS (attach at create)
#   diffract-mcp-sync.sh config             # -> mcp_servers JSON (placeholders) for NEMOCLAW_MCP_SERVERS_B64 at create
#   diffract-mcp-sync.sh apply [<sandbox>]  # re-apply providers + egress + mcp_servers config (post-create)
#   diffract-mcp-sync.sh list               # human-readable: connected MCP servers
#   diffract-mcp-sync.sh remove <name> [<sandbox>]
# ─────────────────────────────────────────────────────────────────────────
set -u
RECORD_DIR="${DIFFRACT_MCP_DIR:-/var/lib/diffract/connected-mcp.d}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
DOCKER="${DOCKER_PATH:-docker}"
MODE="${1:-providers}"
SANDBOX="${2:-${DIFFRACT_SANDBOX:-hermes}}"
# `-` is the chat daemon's cross-netns (binary=-) attribution — required for chat.
MCP_BINARIES=(/usr/bin/python3.13 /opt/hermes/.venv/bin/python3.13 /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python /usr/bin/curl -)

records() { ls "$RECORD_DIR"/*.conf 2>/dev/null; }

# Source a record in a subshell and echo
# "NAME|URL|HOST|HEADER|SECRET_ENV|PROVIDER|EXTRA_HEADERS_B64". URL carries a
# ${SECRET_ENV} placeholder (url-token) or is clean (header-auth). EXTRA_HEADERS_B64 is
# base64 JSON of non-secret static headers (e.g. GHL locationId). No real secret is
# stored in records — it lives in the OpenShell provider. (base64 has no '|', safe.)
record_fields() {
  ( set -e; NAME=; URL=; HOST=; HEADER=; SECRET_ENV=; PROVIDER=; EXTRA_HEADERS_B64=; SANDBOX=; . "$1"
    printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$NAME" "$URL" "$HOST" "$HEADER" "$SECRET_ENV" "$PROVIDER" "$EXTRA_HEADERS_B64" "$SANDBOX" )
}

# Default sandbox — a legacy record with no SANDBOX field belongs to it (so old
# MCP servers don't leak into newly-created boxes).
_DEFSB="$(jq -r '.defaultSandbox // empty' "$HOME/.nemoclaw/sandboxes.json" 2>/dev/null)"
# True iff the record at $1 belongs to the queried $SANDBOX (per-box isolation).
record_in_sandbox() {
  local rsb
  rsb="$(record_fields "$1" | awk -F'|' '{print $8}')"
  [ -z "$rsb" ] && rsb="$_DEFSB"
  [ "$rsb" = "$SANDBOX" ]
}

sandbox_cid() { "$DOCKER" ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1; }

case "$MODE" in
  providers)
    # The provider holding each server's secret is attached at create (so OpenShell
    # injects the placeholder env var the config resolves against).
    out=""
    for f in $(records); do
      IFS='|' read -r NAME URL HOST HEADER SECRET_ENV PROVIDER EXTRA_HEADERS_B64 RSANDBOX < <(record_fields "$f")
      [ -z "$PROVIDER" ] && continue
      [ "${RSANDBOX:-$_DEFSB}" = "$SANDBOX" ] || continue   # per-box: only this sandbox's servers
      out="${out:+$out,}$PROVIDER"
    done
    echo "$out"
    ;;

  apply)
    # Re-apply each server to the freshly-created sandbox: attach provider + egress +
    # placeholder mcp_servers config. Exit non-zero if any server failed.
    rc=0
    cid="$(sandbox_cid)"
    if [ -z "$cid" ]; then
      echo "[mcp-sync] sandbox '$SANDBOX' not running — skipping apply" >&2
      exit 0
    fi
    applied=0
    for f in $(records); do
      IFS='|' read -r NAME URL HOST HEADER SECRET_ENV PROVIDER EXTRA_HEADERS_B64 RSANDBOX < <(record_fields "$f")
      [ -z "$NAME" ] && continue
      [ "${RSANDBOX:-$_DEFSB}" = "$SANDBOX" ] || continue   # per-box: only this sandbox's servers
      # Provider: re-attach (idempotent) so the credential env var is injected.
      "$OPENSHELL" sandbox provider detach "$SANDBOX" "$PROVIDER" >/dev/null 2>&1 || true
      "$OPENSHELL" sandbox provider attach "$SANDBOX" "$PROVIDER" >/dev/null 2>&1 || true
      # Egress (idempotent: same --rule-name updates instead of duplicating). `rest`
      # so the proxy can substitute the credential placeholder; binaries incl `-`.
      binargs=(); for b in "${MCP_BINARIES[@]}"; do binargs+=(--binary "$b"); done
      if "$OPENSHELL" policy update "$SANDBOX" --add-endpoint "${HOST}:full:rest" --rule-name "${NAME}-mcp" "${binargs[@]}" --wait >/dev/null 2>&1; then
        echo "[mcp-sync] egress allowed: $NAME -> $HOST"
      else
        echo "[mcp-sync] WARN: egress failed for $NAME -> $HOST"; rc=1
      fi
      # Write the PLACEHOLDER mcp_servers entry AS THE SANDBOX USER.
      if "$DOCKER" exec -i -u sandbox -e HOME=/sandbox \
          -e MNAME="$NAME" -e MURL="$URL" -e MHEADER="$HEADER" -e MSECRET_ENV="$SECRET_ENV" \
          -e MEXTRA_B64="$EXTRA_HEADERS_B64" "$cid" \
          /opt/hermes/.venv/bin/python - <<'PY' </dev/null >/dev/null 2>&1
import os, json, base64
from ruamel.yaml import YAML
p = "/sandbox/.hermes/config.yaml"
yaml = YAML()
yaml.width = 4096  # never wrap long MCP URLs/headers across lines
try:
    with open(p) as f:
        cfg = yaml.load(f) or {}
except Exception:
    cfg = {}
entry = {"url": os.environ["MURL"], "enabled": True, "connect_timeout": 120, "timeout": 120}
headers = {}
if os.environ.get("MHEADER"):
    # Header value is the placeholder; the provider holds the real value.
    headers[os.environ["MHEADER"]] = "${" + os.environ["MSECRET_ENV"] + "}"
if os.environ.get("MEXTRA_B64"):
    try:
        # name->key map; every value is a host-side placeholder too.
        for hname, hkey in json.loads(base64.b64decode(os.environ["MEXTRA_B64"])).items():
            headers[hname] = "${" + hkey + "}"
    except Exception:
        pass
if headers:
    entry["headers"] = headers
cfg.setdefault("mcp_servers", {})[os.environ["MNAME"]] = entry
with open(p, "w") as f:
    yaml.dump(cfg, f)
PY
      then
        echo "[mcp-sync] configured mcp server: $NAME"
        applied=$((applied+1))
      else
        echo "[mcp-sync] WARN: failed to configure mcp server: $NAME"; rc=1
      fi
    done
    if [ "$applied" -gt 0 ]; then
      nemoclaw "$SANDBOX" recover >/dev/null 2>&1 \
        && echo "[mcp-sync] reloaded gateway" \
        || echo "[mcp-sync] WARN: gateway reload failed — MCP tools reach chat on the next recreate"
    fi
    exit $rc
    ;;

  config)
    # Emit mcp_servers JSON for CREATE-TIME injection (NEMOCLAW_MCP_SERVERS_B64).
    # PLACEHOLDERS ONLY: ${SECRET_ENV} in the url (url-token) or the header value.
    if ! command -v jq >/dev/null 2>&1; then echo "{}"; exit 0; fi
    printf '{'
    first=1
    for f in $(records); do
      IFS='|' read -r NAME URL HOST HEADER SECRET_ENV PROVIDER EXTRA_HEADERS_B64 RSANDBOX < <(record_fields "$f")
      [ -z "$NAME" ] && continue
      [ "${RSANDBOX:-$_DEFSB}" = "$SANDBOX" ] || continue   # per-box: only this sandbox's servers
      [ $first -eq 0 ] && printf ','; first=0
      # Extra headers as a name->KEY map (base64 JSON). Each value becomes a ${KEY}
      # placeholder too, so NOTHING is verbatim in the agent config.
      extra='{}'
      [ -n "$EXTRA_HEADERS_B64" ] && extra="$(printf '%s' "$EXTRA_HEADERS_B64" | base64 -d 2>/dev/null || echo '{}')"
      if [ -n "$HEADER" ] || [ "$extra" != "{}" ]; then
        sec='{}'
        [ -n "$HEADER" ] && sec="$(jq -nc --arg h "$HEADER" --arg v "\${$SECRET_ENV}" '{($h):$v}')"
        printf '%s:%s' "$(jq -nc --arg v "$NAME" '$v')" \
          "$(jq -nc --arg url "$URL" --argjson sec "$sec" --argjson extra "$extra" \
            '{url:$url, headers:($sec + ($extra | with_entries(.value = "${" + .value + "}"))), connect_timeout:120, timeout:120, enabled:true}')"
      else
        printf '%s:{"url":%s,"connect_timeout":120,"timeout":120,"enabled":true}' \
          "$(jq -nc --arg v "$NAME" '$v')" "$(jq -nc --arg v "$URL" '$v')"
      fi
    done
    printf '}\n'
    ;;

  list)
    for f in $(records); do
      IFS='|' read -r NAME URL HOST HEADER SECRET_ENV PROVIDER EXTRA_HEADERS_B64 RSANDBOX < <(record_fields "$f")
      echo "mcp: $NAME  host=$HOST${HEADER:+  header=$HEADER}  provider=$PROVIDER  (secret host-side)"
    done
    ;;

  remove)
    # Disconnect: delete the host record + the OpenShell provider (real secret),
    # drop it from the running agent config, revoke its egress, reload the gateway.
    # Usage: diffract-mcp-sync.sh remove <name> [<sandbox>]
    RNAME="${2:-}"
    RSBX="${3:-${DIFFRACT_SANDBOX:-hermes}}"
    [ -z "$RNAME" ] && { echo "usage: $0 remove <name> [<sandbox>]" >&2; exit 2; }
    RPROVIDER=""
    if [ -f "$RECORD_DIR/${RNAME}.conf" ]; then
      IFS='|' read -r _n _u _h _hd _se RPROVIDER _eh < <(record_fields "$RECORD_DIR/${RNAME}.conf")
    fi
    rm -f "$RECORD_DIR/${RNAME}.conf"
    echo "[mcp-sync] removed record: $RNAME"
    # Drop the provider (real secret leaves the host store).
    if [ -n "$RPROVIDER" ]; then
      "$OPENSHELL" sandbox provider detach "$RSBX" "$RPROVIDER" >/dev/null 2>&1 || true
      "$OPENSHELL" provider delete "$RPROVIDER" >/dev/null 2>&1 \
        && echo "[mcp-sync] deleted provider: $RPROVIDER" || true
    fi
    cid="$("$DOCKER" ps -q -f "label=openshell.ai/sandbox-name=${RSBX}" 2>/dev/null | head -1)"
    if [ -n "$cid" ]; then
      "$DOCKER" exec -i -u sandbox -e HOME=/sandbox -e MNAME="$RNAME" "$cid" \
        /opt/hermes/.venv/bin/python - <<'PY' </dev/null >/dev/null 2>&1 || true
import os
from ruamel.yaml import YAML
p = "/sandbox/.hermes/config.yaml"
yaml = YAML()
yaml.width = 4096
try:
    with open(p) as f:
        cfg = yaml.load(f) or {}
except Exception:
    cfg = {}
srv = cfg.get("mcp_servers") or {}
srv.pop(os.environ["MNAME"], None)
with open(p, "w") as f:
    yaml.dump(cfg, f)
PY
      "$OPENSHELL" policy update "$RSBX" --remove-rule "${RNAME}-mcp" --wait >/dev/null 2>&1 || true
      nemoclaw "$RSBX" recover >/dev/null 2>&1 \
        && echo "[mcp-sync] reloaded gateway (server removed from chat)" \
        || echo "[mcp-sync] WARN: gateway reload failed — removal takes full effect on next recreate"
    fi
    ;;

  *)
    echo "usage: $0 providers | apply [<sandbox>] | config | list | remove <name> [<sandbox>]" >&2; exit 2 ;;
esac
