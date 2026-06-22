#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP sync — makes every connected MCP server usable by the CHAT agent,
# driven entirely by the host-side connection records (no per-server code).
#
# MODEL (token-in-Hermes, by operator choice): the real secret is written
# directly into the agent config (mcp_servers). We do NOT register OpenShell
# providers; we keep ONLY the egress allowlist so the agent can reach the host.
#
# The agent config lives in the ephemeral sandbox (wiped on recreate), so it is
# re-applied at each deploy from the records written by diffract-mcp-connect.sh:
#
#   diffract-mcp-sync.sh providers          # -> EMPTY (no OpenShell providers in this model)
#   diffract-mcp-sync.sh config             # -> mcp_servers JSON (real tokens) for NEMOCLAW_MCP_SERVERS_B64 at create
#   diffract-mcp-sync.sh apply [<sandbox>]  # re-apply egress + mcp_servers config + reload (post-create)
#   diffract-mcp-sync.sh list               # human-readable: connected MCP servers
# ─────────────────────────────────────────────────────────────────────────
set -u
RECORD_DIR="${DIFFRACT_MCP_DIR:-/var/lib/diffract/connected-mcp.d}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
DOCKER="${DOCKER_PATH:-docker}"
MODE="${1:-providers}"
SANDBOX="${2:-${DIFFRACT_SANDBOX:-hermes}}"
MCP_BINARIES=(/usr/bin/python3.13 /opt/hermes/.venv/bin/python3.13 /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python /usr/bin/curl)
# URL-token MCP servers are run via a stdio bridge SUBPROCESS: the daemon's own in-process
# egress is mis-attributed (binary=-) and 403'd by the proxy, but a subprocess is attributed
# to its real binary and allowed. The bridge is baked into the agent image (Dockerfile.base
# copies agents/hermes/diffract-mcp-bridge.py to this path). See
# docs/bugs/openshell-egress-attribution-mcp-403.md.
MCP_BRIDGE="${DIFFRACT_MCP_BRIDGE:-/opt/hermes/diffract-mcp-bridge.py}"
MCP_PYTHON="${DIFFRACT_MCP_PYTHON:-/opt/hermes/.venv/bin/python}"

records() { ls "$RECORD_DIR"/*.conf 2>/dev/null; }

# Source a record file in a subshell and echo "NAME|URL|SECRET|HOST|HEADER".
# URL carries the real token for URL-token servers; HEADER+SECRET carry the
# header name + real value for header-auth servers.
record_fields() {
  ( set -e; NAME=; URL=; SECRET=; HOST=; HEADER=; . "$1"
    printf '%s|%s|%s|%s|%s\n' "$NAME" "$URL" "$SECRET" "$HOST" "$HEADER" )
}

sandbox_cid() { "$DOCKER" ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1; }

case "$MODE" in
  providers)
    # Token-in-Hermes model registers no OpenShell providers.
    echo ""
    ;;

  apply)
    # Re-apply each server to the freshly-created sandbox: egress + mcp_servers
    # config (with the real token). Exit non-zero if any server failed.
    rc=0
    cid="$(sandbox_cid)"
    if [ -z "$cid" ]; then
      echo "[mcp-sync] sandbox '$SANDBOX' not running — skipping apply" >&2
      exit 0
    fi
    applied=0
    for f in $(records); do
      IFS='|' read -r NAME URL SECRET HOST HEADER < <(record_fields "$f")
      [ -z "$NAME" ] && continue
      # Egress (idempotent: same --rule-name updates instead of duplicating).
      binargs=(); for b in "${MCP_BINARIES[@]}"; do binargs+=(--binary "$b"); done
      if "$OPENSHELL" policy update "$SANDBOX" --add-endpoint "${HOST}:full" --rule-name "${NAME}-mcp" "${binargs[@]}" --wait >/dev/null 2>&1; then
        echo "[mcp-sync] egress allowed: $NAME -> $HOST"
      else
        echo "[mcp-sync] WARN: egress failed for $NAME -> $HOST"; rc=1
      fi
      # Write mcp_servers (REAL token) into the agent config AS THE SANDBOX USER.
      if "$DOCKER" exec -i -u sandbox -e HOME=/sandbox \
          -e MNAME="$NAME" -e MURL="$URL" -e MHEADER="$HEADER" -e MSECRET="$SECRET" \
          -e MPY="$MCP_PYTHON" -e MBRIDGE="$MCP_BRIDGE" "$cid" \
          /opt/hermes/.venv/bin/python - <<'PY' </dev/null >/dev/null 2>&1
import os
from ruamel.yaml import YAML
p = "/sandbox/.hermes/config.yaml"
yaml = YAML()
yaml.width = 4096  # never wrap long MCP URLs/tokens across lines (folds a space -> breaks auth)
try:
    with open(p) as f:
        cfg = yaml.load(f) or {}
except Exception:
    cfg = {}
if os.environ.get("MHEADER"):
    # Header-auth servers stay direct (header substitution); rare, and can move to the
    # bridge later if needed.
    entry = {"url": os.environ["MURL"], "enabled": True,
             "headers": {os.environ["MHEADER"]: os.environ["MSECRET"]}}
else:
    # URL-token servers run via the stdio bridge subprocess (correct egress attribution).
    entry = {"command": os.environ["MPY"],
             "args": [os.environ["MBRIDGE"], os.environ["MURL"]],
             "enabled": True}
cfg.setdefault("mcp_servers", {})[os.environ["MNAME"]] = entry
with open(p, "w") as f:
    yaml.dump(cfg, f)
PY
      then
        echo "[mcp-sync] configured + enabled mcp server: $NAME"
        applied=$((applied+1))
      else
        echo "[mcp-sync] WARN: failed to configure mcp server: $NAME"; rc=1
      fi
    done
    # Reload the gateway so the running chat daemon re-reads mcp_servers.
    if [ "$applied" -gt 0 ]; then
      nemoclaw "$SANDBOX" recover >/dev/null 2>&1 \
        && echo "[mcp-sync] reloaded gateway to load MCP tools" \
        || echo "[mcp-sync] WARN: gateway reload failed — MCP tools reach chat on the next recreate"
    fi
    exit $rc
    ;;

  config)
    # Emit mcp_servers JSON for CREATE-TIME injection (NEMOCLAW_MCP_SERVERS_B64).
    # Holds the REAL token (URL-token in the URL; header servers as headers map).
    if ! command -v jq >/dev/null 2>&1; then echo "{}"; exit 0; fi
    printf '{'
    first=1
    for f in $(records); do
      IFS='|' read -r NAME URL SECRET HOST HEADER < <(record_fields "$f")
      [ -z "$NAME" ] && continue
      [ $first -eq 0 ] && printf ','; first=0
      if [ -n "$HEADER" ]; then
        printf '%s:{"url":%s,"headers":{%s:%s},"enabled":true}' \
          "$(jq -nc --arg v "$NAME" '$v')" "$(jq -nc --arg v "$URL" '$v')" \
          "$(jq -nc --arg v "$HEADER" '$v')" "$(jq -nc --arg v "$SECRET" '$v')"
      else
        # URL-token: command-based (stdio bridge subprocess) so create-time discovery in the
        # daemon reaches the server with correct egress attribution.
        printf '%s:{"command":%s,"args":[%s,%s],"enabled":true}' \
          "$(jq -nc --arg v "$NAME" '$v')" "$(jq -nc --arg v "$MCP_PYTHON" '$v')" \
          "$(jq -nc --arg v "$MCP_BRIDGE" '$v')" "$(jq -nc --arg v "$URL" '$v')"
      fi
    done
    printf '}\n'
    ;;

  list)
    for f in $(records); do
      IFS='|' read -r NAME URL SECRET HOST HEADER < <(record_fields "$f")
      echo "mcp: $NAME  host=$HOST${HEADER:+  header=$HEADER}  (token-in-hermes)"
    done
    ;;

  remove)
    # Disconnect a connected MCP server by name: delete the host record (so it is
    # NOT re-applied at the next create), drop it from the running agent config,
    # best-effort revoke its egress rule, then reload the gateway so chat stops
    # using it. Usage: diffract-mcp-sync.sh remove <name> [<sandbox>]
    RNAME="${2:-}"
    RSBX="${3:-${DIFFRACT_SANDBOX:-hermes}}"
    [ -z "$RNAME" ] && { echo "usage: $0 remove <name> [<sandbox>]" >&2; exit 2; }
    rm -f "$RECORD_DIR/${RNAME}.conf"
    echo "[mcp-sync] removed record: $RNAME"
    cid="$("$DOCKER" ps -q -f "label=openshell.ai/sandbox-name=${RSBX}" 2>/dev/null | head -1)"
    if [ -n "$cid" ]; then
      # Drop the server from the running config (AS THE SANDBOX USER).
      "$DOCKER" exec -i -u sandbox -e HOME=/sandbox -e MNAME="$RNAME" "$cid" \
        /opt/hermes/.venv/bin/python - <<'PY' </dev/null >/dev/null 2>&1 || true
import os
from ruamel.yaml import YAML
p = "/sandbox/.hermes/config.yaml"
yaml = YAML()
yaml.width = 4096  # never wrap long MCP URLs/tokens across lines (folds a space -> breaks auth)
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
      # Best-effort: revoke the egress rule the connect flow added ("<name>-mcp").
      "$OPENSHELL" policy update "$RSBX" --remove-rule "${RNAME}-mcp" --wait >/dev/null 2>&1 || true
      nemoclaw "$RSBX" recover >/dev/null 2>&1 \
        && echo "[mcp-sync] reloaded gateway (server removed from chat)" \
        || echo "[mcp-sync] WARN: gateway reload failed — removal takes full effect on next recreate"
    fi
    ;;

  *)
    echo "usage: $0 providers | apply [<sandbox>] | config | list | remove <name> [<sandbox>]" >&2; exit 2 ;;
esac
