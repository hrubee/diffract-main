#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract MCP sync — makes every connected MCP server usable by the CHAT agent,
# driven entirely by the host-side connection records (no per-server code).
#
# WHY THIS EXISTS (same reason as diffract-tool-sync.sh): OpenShell >= 0.0.57
# injects a provider's credential into the long-running agent daemon ONLY at
# sandbox CREATE. So for an MCP server's token-placeholder to resolve in CHAT,
# its provider must be attached at create. And the agent's config (mcp_servers)
# lives in the ephemeral sandbox, wiped on recreate — so it must be re-applied at
# each deploy. Both are derived from the records written by diffract-mcp-connect.sh.
#
#   diffract-mcp-sync.sh providers          # -> comma list for NEMOCLAW_SANDBOX_EXTRA_PROVIDERS (attach at create)
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

records() { ls "$RECORD_DIR"/*.conf 2>/dev/null; }

# Source a record file in a subshell and echo "NAME|URL|SECRET_ENV|HOST|PROVIDER".
record_fields() {
  ( set -e; NAME=; URL=; SECRET_ENV=; HOST=; PROVIDER=; . "$1"
    printf '%s|%s|%s|%s|%s\n' "$NAME" "$URL" "$SECRET_ENV" "$HOST" "$PROVIDER" )
}

sandbox_cid() { "$DOCKER" ps -q -f "label=openshell.ai/sandbox-name=${SANDBOX}" 2>/dev/null | head -1; }

case "$MODE" in
  providers)
    # Comma-separated MCP provider names for the onboard to attach at create.
    out=""
    for f in $(records); do
      p="$(record_fields "$f" | cut -d'|' -f5)"
      [ -n "$p" ] && out="${out:+$out,}$p"
    done
    echo "$out"
    ;;

  apply)
    # Re-apply each server to the freshly-created sandbox: egress + mcp_servers
    # config. Exit non-zero if any server failed so the deploy route can surface
    # it. The provider is attached at create (see `providers`), so the daemon env
    # already holds the placeholder when the config is written.
    rc=0
    cid="$(sandbox_cid)"
    if [ -z "$cid" ]; then
      echo "[mcp-sync] sandbox '$SANDBOX' not running — skipping apply" >&2
      exit 0
    fi
    applied=0
    for f in $(records); do
      IFS='|' read -r NAME URL SECRET_ENV HOST PROVIDER < <(record_fields "$f")
      [ -z "$NAME" ] && continue
      # Egress (idempotent: same --rule-name updates instead of duplicating).
      binargs=(); for b in "${MCP_BINARIES[@]}"; do binargs+=(--binary "$b"); done
      if "$OPENSHELL" policy update "$SANDBOX" --add-endpoint "${HOST}:full" --rule-name "${NAME}-mcp" "${binargs[@]}" --wait >/dev/null 2>&1; then
        echo "[mcp-sync] egress allowed: $NAME -> $HOST"
      else
        echo "[mcp-sync] WARN: egress failed for $NAME -> $HOST"; rc=1
      fi
      # Write mcp_servers into the agent config (placeholder URL). Feeds the
      # interactive prompts (no separate auth; enable all tools).
      if "$DOCKER" exec "$cid" bash -lc "printf 'n\ny\n' | hermes mcp add $(printf '%q' "$NAME") --url $(printf '%q' "$URL")" </dev/null >/dev/null 2>&1; then
        echo "[mcp-sync] configured mcp server: $NAME"
        applied=$((applied+1))
      else
        echo "[mcp-sync] WARN: failed to configure mcp server: $NAME"; rc=1
      fi
    done
    # Reload the gateway so the running chat daemon picks up the new mcp_servers
    # (it started at create before this config was written). Best-effort.
    if [ "$applied" -gt 0 ]; then
      if "$OPENSHELL" sandbox provider list "$SANDBOX" >/dev/null 2>&1; then :; fi
      nemoclaw "$SANDBOX" hermes recover >/dev/null 2>&1 \
        && echo "[mcp-sync] reloaded gateway to load MCP tools" \
        || echo "[mcp-sync] WARN: gateway reload failed — MCP tools reach chat on the next recreate"
    fi
    exit $rc
    ;;

  list)
    for f in $(records); do
      IFS='|' read -r NAME URL SECRET_ENV HOST PROVIDER < <(record_fields "$f")
      echo "mcp: $NAME  host=$HOST  provider=$PROVIDER  secret_env=$SECRET_ENV"
    done
    ;;

  *)
    echo "usage: $0 providers | apply [<sandbox>] | list" >&2; exit 2 ;;
esac
