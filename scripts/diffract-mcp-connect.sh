#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP connector — securely connect an MCP server (Zapier, Notion, …)
# to the Hermes agent so it can use the server's tools WITHOUT ever holding the
# server's secret.
#
# Same security model as diffract-tool-connect.sh, applied to MCP:
#   1. The server's secret (e.g. the token in a Zapier `?token=…` URL) is stored
#      in an OpenShell `generic` provider, keyed by <SECRET_ENV>. The sandbox only
#      ever sees a PLACEHOLDER (openshell:resolve:env:<SECRET_ENV>); the L7 proxy
#      substitutes the real value at egress (headers AND query params). The agent
#      never holds the secret, and it never lands in the sandbox config or backups.
#   2. The mcp_servers URL stored in the agent config uses ${SECRET_ENV}, which
#      Hermes interpolates to the placeholder at runtime — proven: the proxy then
#      swaps in the real token and the server authenticates.
#   3. Egress is allowed ONLY to the MCP host, attributed to the agent's python
#      binary (and curl), so the agent can reach the server and nothing else.
#
# The SECRET VALUE is read from THIS PROCESS'S ENVIRONMENT (never argv), so it
# never appears in the process list. Set it before calling:
#
#   ZAPIER_MCP_TOKEN=xxx diffract-mcp-connect.sh test zapier \
#       'https://mcp.zapier.com/api/v1/connect?token=${ZAPIER_MCP_TOKEN}' \
#       ZAPIER_MCP_TOKEN mcp.zapier.com:443
#
# Usage: diffract-mcp-connect.sh <sandbox> <name> <url-with-placeholder> <secretEnv> <host:port>
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SANDBOX="${1:-}"
NAME="${2:-}"
URL="${3:-}"
SECRET_ENV="${4:-}"
HOSTPORT="${5:-}"

PROVIDER="${NAME}-mcp"
RECORD_DIR="${DIFFRACT_MCP_DIR:-/var/lib/diffract/connected-mcp.d}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
# Binaries that may open the MCP connection from inside the sandbox: the Hermes
# python (the MCP client) and curl (if the agent shells out). Egress is attributed
# to these so the proxy permits the connection.
MCP_BINARIES=(/usr/bin/python3.13 /opt/hermes/.venv/bin/python3.13 /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python /usr/bin/curl)

if [ -z "$SANDBOX" ] || [ -z "$NAME" ] || [ -z "$URL" ] || [ -z "$SECRET_ENV" ] || [ -z "$HOSTPORT" ]; then
  echo "usage: diffract-mcp-connect.sh <sandbox> <name> <url-with-placeholder> <secretEnv> <host:port>" >&2
  exit 2
fi

# The secret value must be in the environment under $SECRET_ENV.
if [ -z "${!SECRET_ENV:-}" ]; then
  echo "[mcp-connect] missing secret in environment: $SECRET_ENV" >&2
  echo "[mcp-connect] re-run with: ${SECRET_ENV}=<value> diffract-mcp-connect.sh $SANDBOX $NAME ..." >&2
  exit 1
fi

# 1. Register the provider holding the real secret (sandbox sees a placeholder).
#    --credential KEY reads the value from THIS process's env (never argv).
echo "[mcp-connect] registering provider '$PROVIDER' (generic) with: $SECRET_ENV"
if "$OPENSHELL" provider get "$PROVIDER" >/dev/null 2>&1; then
  "$OPENSHELL" provider update "$PROVIDER" --credential "$SECRET_ENV" >/dev/null
else
  "$OPENSHELL" provider create --name "$PROVIDER" --type generic --credential "$SECRET_ENV" >/dev/null
fi

# 2. Attach to the sandbox (detach+attach forces re-injection of the placeholder
#    into new exec sessions; for the CHAT daemon it binds at the next create).
echo "[mcp-connect] attaching provider '$PROVIDER' to sandbox '$SANDBOX'"
"$OPENSHELL" sandbox provider detach "$SANDBOX" "$PROVIDER" >/dev/null 2>&1 || true
"$OPENSHELL" sandbox provider attach "$SANDBOX" "$PROVIDER" >/dev/null

# 3. Allow egress to ONLY the MCP host, attributed to the agent's binaries.
echo "[mcp-connect] allowing egress to: $HOSTPORT"
bin_args=()
for b in "${MCP_BINARIES[@]}"; do bin_args+=(--binary "$b"); done
"$OPENSHELL" policy update "$SANDBOX" \
  --add-endpoint "${HOSTPORT}:full" \
  --rule-name "${NAME}-mcp" \
  "${bin_args[@]}" --wait >/dev/null
echo "[mcp-connect]   allowed ${HOSTPORT}"

# 4. Record the connection host-side (survives recreate; re-applied at create by
#    diffract-mcp-sync.sh). Stored as a shell-sourceable file. The URL holds the
#    PLACEHOLDER (${SECRET_ENV}), never the real token.
mkdir -p "$RECORD_DIR"
umask 077
cat > "$RECORD_DIR/${NAME}.conf" <<EOF
NAME=$(printf '%q' "$NAME")
URL=$(printf '%q' "$URL")
SECRET_ENV=$(printf '%q' "$SECRET_ENV")
HOST=$(printf '%q' "$HOSTPORT")
PROVIDER=$(printf '%q' "$PROVIDER")
EOF
echo "[mcp-connect] recorded '$NAME' in $RECORD_DIR/${NAME}.conf (re-applied at next create)"

# 5. Best-effort: add the server to the RUNNING sandbox's agent config so it's
#    usable in new exec sessions immediately. The CHAT daemon binds the provider
#    env at create, so chat picks it up on the next deploy/recreate (see note).
if command -v docker >/dev/null 2>&1; then
  cid="$(docker ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1 || true)"
  if [ -n "$cid" ]; then
    echo "[mcp-connect] adding '$NAME' to the running sandbox agent config (exec-immediate)"
    # `printf` feeds the interactive prompts (no separate auth; enable all tools).
    docker exec "$cid" bash -lc "printf 'n\ny\n' | hermes mcp add $(printf '%q' "$NAME") --url $(printf '%q' "$URL") >/dev/null 2>&1 || true" </dev/null 2>&1 || true
  fi
fi

echo "[mcp-connect] done — '$NAME' is wired to sandbox '$SANDBOX'. The secret stays host-side;"
echo "[mcp-connect] the agent sees only a placeholder. Recreate the sandbox (deploy) to use it in chat."
