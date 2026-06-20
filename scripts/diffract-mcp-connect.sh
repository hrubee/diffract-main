#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP connector — connect an MCP server (Zapier, Stitch, Notion, …)
# to the Hermes agent.
#
# MODEL (token-in-Hermes, by operator choice): the server's secret is written
# DIRECTLY into the Hermes agent config (mcp_servers) — no OpenShell provider,
# no ${PLACEHOLDER} rewriting. We keep ONLY the egress allowlist so the agent
# can reach the MCP host (OpenShell denies all non-allowlisted egress, so this
# is required for connectivity).
#
#   • URL-token servers (Zapier `?token=…`): the real token rides in the URL.
#   • Header-auth servers (Stitch `X-Goog-Api-Key`): the real key rides in a
#     request header.
#
# TRADEOFF (accepted): the real secret now lives inside the sandbox config and
# in the host-side record below (root-only, mode 600). It is no longer kept
# host-side-only behind the L7 proxy. This is the operator-selected behaviour.
#
# The SECRET VALUE is read from THIS PROCESS'S ENVIRONMENT (never argv), so it
# never appears in the process list:
#
#   ZAPIER_MCP_TOKEN=xxx diffract-mcp-connect.sh test zapier \
#       'https://mcp.zapier.com/api/v1/connect?token=${ZAPIER_MCP_TOKEN}' \
#       ZAPIER_MCP_TOKEN mcp.zapier.com:443
#
# Usage: diffract-mcp-connect.sh <sandbox> <name> <url[-with-placeholder]> <secretEnv> <host:port> [headerName]
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SANDBOX="${1:-}"
NAME="${2:-}"
URL="${3:-}"
SECRET_ENV="${4:-}"
HOSTPORT="${5:-}"
# Optional 6th arg: a request-header NAME (e.g. X-Goog-Api-Key) for header-auth
# MCP servers. When set, the secret is injected via this header; otherwise the
# secret is expected as a ${SECRET_ENV} placeholder embedded in the URL.
HEADER="${6:-}"

RECORD_DIR="${DIFFRACT_MCP_DIR:-/var/lib/diffract/connected-mcp.d}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
# Binaries that may open the MCP connection from inside the sandbox: the Hermes
# python (the MCP client) and curl (if the agent shells out). Egress is attributed
# to these so the proxy permits the connection.
MCP_BINARIES=(/usr/bin/python3.13 /opt/hermes/.venv/bin/python3.13 /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python /usr/bin/curl)

if [ -z "$SANDBOX" ] || [ -z "$NAME" ] || [ -z "$URL" ] || [ -z "$SECRET_ENV" ] || [ -z "$HOSTPORT" ]; then
  echo "usage: diffract-mcp-connect.sh <sandbox> <name> <url[-with-placeholder]> <secretEnv> <host:port> [headerName]" >&2
  exit 2
fi

# The secret value must be in the environment under $SECRET_ENV.
SECRET="$(printenv "$SECRET_ENV" || true)"
if [ -z "$SECRET" ]; then
  echo "[mcp-connect] missing secret in environment: $SECRET_ENV" >&2
  echo "[mcp-connect] re-run with: ${SECRET_ENV}=<value> diffract-mcp-connect.sh $SANDBOX $NAME ..." >&2
  exit 1
fi

# Resolve the REAL url: substitute the placeholder ${SECRET_ENV} with the real
# secret (URL-token servers). Header servers pass a clean URL (no placeholder),
# so this leaves it untouched.
REAL_URL="${URL//\$\{$SECRET_ENV\}/$SECRET}"

# 1. Allow egress to ONLY the MCP host, attributed to the agent's binaries.
#    This is the one OpenShell touchpoint we keep: without it the sandbox cannot
#    reach the MCP host at all (deny-by-default egress).
echo "[mcp-connect] allowing egress to: $HOSTPORT"
bin_args=()
for b in "${MCP_BINARIES[@]}"; do bin_args+=(--binary "$b"); done
"$OPENSHELL" policy update "$SANDBOX" \
  --add-endpoint "${HOSTPORT}:full" \
  --rule-name "${NAME}-mcp" \
  "${bin_args[@]}" --wait >/dev/null
echo "[mcp-connect]   allowed ${HOSTPORT}"

# 2. Best-effort: drop any legacy OpenShell provider from the old (placeholder)
#    model so it is not re-attached on future deploys.
if "$OPENSHELL" provider get "${NAME}-mcp" >/dev/null 2>&1; then
  "$OPENSHELL" sandbox provider detach "$SANDBOX" "${NAME}-mcp" >/dev/null 2>&1 || true
  "$OPENSHELL" provider delete "${NAME}-mcp" >/dev/null 2>&1 || true
  echo "[mcp-connect] removed legacy OpenShell provider '${NAME}-mcp' (token now lives in Hermes)"
fi

# 3. Record the connection host-side (root-only; survives recreate; re-applied at
#    create by diffract-mcp-sync.sh). Holds the REAL secret — chmod 600 via umask.
#    HEADER set => header-auth (URL clean, SECRET is the header value).
#    HEADER empty => URL-token (REAL_URL already carries the token).
mkdir -p "$RECORD_DIR"
umask 077
cat > "$RECORD_DIR/${NAME}.conf" <<EOF
NAME=$(printf '%q' "$NAME")
URL=$(printf '%q' "$REAL_URL")
SECRET=$(printf '%q' "$SECRET")
HOST=$(printf '%q' "$HOSTPORT")
HEADER=$(printf '%q' "$HEADER")
EOF
echo "[mcp-connect] recorded '$NAME' in $RECORD_DIR/${NAME}.conf (re-applied at next create)"

# 4. Write the server into the RUNNING sandbox's agent config with the REAL token,
#    AS THE SANDBOX USER (HOME=/sandbox) so it lands in /sandbox/.hermes/config.yaml.
if command -v docker >/dev/null 2>&1; then
  cid="$(docker ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1 || true)"
  if [ -n "$cid" ]; then
    echo "[mcp-connect] adding '$NAME' to the running sandbox agent config"
    docker exec -i -u sandbox -e HOME=/sandbox \
      -e MNAME="$NAME" -e MURL="$REAL_URL" -e MHEADER="$HEADER" -e MSECRET="$SECRET" "$cid" \
      /opt/hermes/.venv/bin/python - <<'PY' >/dev/null 2>&1 || true
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
entry = {"url": os.environ["MURL"], "enabled": True}
if os.environ.get("MHEADER"):
    entry["headers"] = {os.environ["MHEADER"]: os.environ["MSECRET"]}
cfg.setdefault("mcp_servers", {})[os.environ["MNAME"]] = entry
with open(p, "w") as f:
    yaml.dump(cfg, f)
PY
  fi
fi

# 5. Reload the running gateway so the CHAT agent picks up the new MCP server
#    immediately. The gateway caches its config + egress at start, so without a
#    reload a freshly-connected server keeps failing ("initial connection failed")
#    until the next redeploy. `nemoclaw <sandbox> recover` reloads it in place.
#    Best-effort — the server is already recorded, so a redeploy still works if
#    this fails. (The host record is also re-applied at every create.)
if command -v nemoclaw >/dev/null 2>&1; then
  if nemoclaw "$SANDBOX" recover >/dev/null 2>&1; then
    echo "[mcp-connect] reloaded gateway — '$NAME' is usable in chat now (start a fresh chat)"
  else
    echo "[mcp-connect] NOTE: gateway reload failed — redeploy the sandbox to use '$NAME' in chat"
  fi
fi

echo "[mcp-connect] done — '$NAME' is wired to sandbox '$SANDBOX'."
