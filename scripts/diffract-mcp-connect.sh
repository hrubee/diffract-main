#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP connector — SECURE host-side-secret model.
#
# The real secret lives ONLY in an OpenShell provider (the host-side gateway
# store, never on disk and never in the sandbox). The sandbox agent config and
# the host record carry ONLY a ${SECRET_ENV} placeholder.
#
# HOW THE SECRET REACHES THE UPSTREAM WITHOUT THE AGENT EVER SEEING IT:
#   1. The provider holds the real value under credential key SECRET_ENV.
#   2. At sandbox CREATE, OpenShell injects an env var named SECRET_ENV whose
#      VALUE is an opaque token (openshell:resolve:env:…) — NOT the real secret.
#   3. Hermes expands ${SECRET_ENV} in the mcp_servers config to that opaque token
#      (tools/mcp_tool.py _interpolate_env_vars).
#   4. The OpenShell L7 proxy resolves the opaque token to the real secret at
#      egress — but ONLY on TLS-terminated (`rest`) endpoints, in headers AND
#      query params. So the egress rule below uses `:rest`.
# Result: the real secret is in neither the config file nor the sandbox env. The
# agent sees only ${SECRET_ENV} (config) / openshell:resolve:env:… (env). Proven
# on-box. (See docs/bugs/openshell-egress-attribution-mcp-403.md.)
#
#   • URL-token servers (Zapier ?token=…): url carries ${SECRET_ENV}; the provider
#     holds the raw token.
#   • Header-auth servers (GHL Authorization: Bearer …): url is clean; the header
#     value is ${SECRET_ENV}; the provider holds the FULL header value
#     (e.g. "Bearer pit-…"), so substitution yields the exact header GHL expects.
#
# Because OpenShell injects the credential only at sandbox CREATE, a freshly
# connected server reaches the CHAT agent on the next redeploy/recreate.
#
# The SECRET value is read from THIS PROCESS's ENVIRONMENT under $SECRET_ENV
# (never argv), so it never appears in the process list.
#
# Usage: diffract-mcp-connect.sh <sandbox> <name> <url[-with-${SECRET_ENV}]> <secretEnv> <host:port> [headerName]
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SANDBOX="${1:-}"
NAME="${2:-}"
URL="${3:-}"
SECRET_ENV="${4:-}"
HOSTPORT="${5:-}"
# Optional 6th arg: request-header NAME (e.g. Authorization) for header-auth MCP
# servers. When set, the secret ($SECRET_ENV) is the FULL header value to send.
HEADER="${6:-}"

RECORD_DIR="${DIFFRACT_MCP_DIR:-/var/lib/diffract/connected-mcp.d}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
PROVIDER="${NAME}-mcp"
# Binaries permitted to open the MCP egress. `-` is the chat daemon's own
# cross-netns (binary=-) attribution: the agent connects in-process and the proxy
# cannot trace it to a binary across the veth, so `-` MUST be allowed for chat to
# work. The python/curl paths cover correctly-attributed exec-session callers.
MCP_BINARIES=(/usr/bin/python3.13 /opt/hermes/.venv/bin/python3.13 /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python /usr/bin/curl -)

if [ -z "$SANDBOX" ] || [ -z "$NAME" ] || [ -z "$URL" ] || [ -z "$SECRET_ENV" ] || [ -z "$HOSTPORT" ]; then
  echo "usage: diffract-mcp-connect.sh <sandbox> <name> <url[-with-\${SECRET_ENV}]> <secretEnv> <host:port> [headerName]" >&2
  exit 2
fi

# The secret value must be in the environment under $SECRET_ENV (never argv).
SECRET="$(printenv "$SECRET_ENV" || true)"
if [ -z "$SECRET" ]; then
  echo "[mcp-connect] missing secret in environment: $SECRET_ENV" >&2
  echo "[mcp-connect] re-run with: ${SECRET_ENV}=<value> diffract-mcp-connect.sh $SANDBOX $NAME ..." >&2
  exit 1
fi

# Additional headers (e.g. GoHighLevel's `locationId`) — their VALUES are also held
# host-side, so NOTHING is visible to the agent. The route derives one provider
# credential key per header and passes DIFFRACT_MCP_EXTRA_KEYS, a JSON map
# {headerName: ENV_KEY}; each ENV_KEY's value is in this process's env. We store the
# name->key map in the record (EXTRA_HEADERS_B64) and the values in the provider.
cred_args=(--credential "${SECRET_ENV}=${SECRET}")
EXTRA_HEADERS_B64=""
if [ -n "${DIFFRACT_MCP_EXTRA_KEYS:-}" ] && [ "${DIFFRACT_MCP_EXTRA_KEYS}" != "{}" ]; then
  EXTRA_HEADERS_B64="$(printf '%s' "$DIFFRACT_MCP_EXTRA_KEYS" | base64 -w0)"
  while IFS= read -r ekey; do
    [ -z "$ekey" ] && continue
    cred_args+=(--credential "${ekey}=$(printenv "$ekey" || true)")
  done < <(printf '%s' "$DIFFRACT_MCP_EXTRA_KEYS" | jq -r '.[]' 2>/dev/null)
fi

# 1. Store EVERY header value host-side in one OpenShell provider. OpenShell injects an
#    env var per credential key; ${KEY} in the config resolves to an opaque token the L7
#    proxy swaps for the real value at egress. No header value ever touches the sandbox.
if "$OPENSHELL" provider get "$PROVIDER" >/dev/null 2>&1; then
  "$OPENSHELL" provider update "$PROVIDER" "${cred_args[@]}" >/dev/null
else
  "$OPENSHELL" provider create --name "$PROVIDER" --type generic "${cred_args[@]}" >/dev/null
fi
echo "[mcp-connect] stored $(( ${#cred_args[@]} / 2 )) header value(s) host-side in provider '$PROVIDER'"
# Attach now; re-attached at every create by diffract-mcp-sync.sh providers.
"$OPENSHELL" sandbox provider detach "$SANDBOX" "$PROVIDER" >/dev/null 2>&1 || true
"$OPENSHELL" sandbox provider attach "$SANDBOX" "$PROVIDER" >/dev/null 2>&1 || true

# 2. Allow egress to the MCP host. `rest` => the proxy TLS-terminates so it can
#    substitute the credential placeholder; binaries include `-` for the daemon.
bin_args=(); for b in "${MCP_BINARIES[@]}"; do bin_args+=(--binary "$b"); done
"$OPENSHELL" policy update "$SANDBOX" \
  --add-endpoint "${HOSTPORT}:full:rest" \
  --rule-name "${NAME}-mcp" \
  "${bin_args[@]}" --wait >/dev/null
echo "[mcp-connect] allowed egress ${HOSTPORT} (rest, incl. binary=-)"

# 3. Record the connection host-side — PLACEHOLDER ONLY (no real secret). Survives
#    recreate; re-applied at create by diffract-mcp-sync.sh. URL carries ${SECRET_ENV}
#    for url-token servers, or is clean for header-auth (HEADER set).
mkdir -p "$RECORD_DIR"
umask 077
cat > "$RECORD_DIR/${NAME}.conf" <<EOF
NAME=$(printf '%q' "$NAME")
URL=$(printf '%q' "$URL")
HOST=$(printf '%q' "$HOSTPORT")
HEADER=$(printf '%q' "$HEADER")
SECRET_ENV=$(printf '%q' "$SECRET_ENV")
PROVIDER=$(printf '%q' "$PROVIDER")
EXTRA_HEADERS_B64=$(printf '%q' "$EXTRA_HEADERS_B64")
EOF
echo "[mcp-connect] recorded '$NAME' (placeholder only) in $RECORD_DIR/${NAME}.conf"

# 4. Write the placeholder server into the running sandbox config so the dashboard
#    and exec sessions see it. It resolves in CHAT once the provider injects
#    $SECRET_ENV at the next create — OpenShell binds credentials at create, so a
#    redeploy is required for the chat agent to use it.
if command -v docker >/dev/null 2>&1; then
  cid="$(docker ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1 || true)"
  if [ -n "$cid" ]; then
    docker exec -i -u sandbox -e HOME=/sandbox \
      -e MNAME="$NAME" -e MURL="$URL" -e MHEADER="$HEADER" -e MSECRET_ENV="$SECRET_ENV" \
      -e MEXTRA_B64="$EXTRA_HEADERS_B64" "$cid" \
      /opt/hermes/.venv/bin/python - <<'PY' >/dev/null 2>&1 || true
import os, json, base64
from ruamel.yaml import YAML
p = "/sandbox/.hermes/config.yaml"
yaml = YAML()
yaml.width = 4096  # never wrap long MCP URLs across lines
try:
    with open(p) as f:
        cfg = yaml.load(f) or {}
except Exception:
    cfg = {}
entry = {"url": os.environ["MURL"], "enabled": True}
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
  fi
fi

echo "[mcp-connect] done — '$NAME' wired to '$SANDBOX'. The secret stays host-side; the agent sees only a placeholder. Redeploy to use it in chat."
