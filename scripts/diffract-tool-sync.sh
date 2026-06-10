#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract universal tool sync — makes EVERY connected tool usable by the
# chat agent, driven entirely by the tool registry (no per-tool code).
#
# WHY THIS EXISTS: OpenShell >= 0.0.57 injects a tool's credential into the
# long-running agent daemon ONLY at sandbox CREATE (a provider attached after
# create reaches new exec sessions but not the running chat daemon). So for a
# tool to be usable *in chat*, its provider must be (a) attached at create and
# (b) egress-allowed (host + attributed binary). Both are derivable from the
# registry, so adding any new CLI is: add a registry entry + connect it — the
# deploy flow then wires it for chat automatically. No code per tool.
#
# A tool is "connected" iff a registry tool (diffract-tools.json) has a matching
# OpenShell provider of the same name (created by the connect flow).
#
#   diffract-tool-sync.sh providers            # -> comma list for NEMOCLAW_SANDBOX_EXTRA_PROVIDERS
#   diffract-tool-sync.sh egress  [<sandbox>]  # apply each connected tool's egress (apiHosts + binaries)
#   diffract-tool-sync.sh list                 # human-readable: connected tools + their hosts/binaries
# ─────────────────────────────────────────────────────────────────────────
set -u
REGISTRY="${DIFFRACT_TOOLS_REGISTRY:-/usr/local/share/diffract/diffract-tools.json}"
# Gateway-INDEPENDENT list of connected tools, maintained by the connect flow
# (diffract-tool-connect.sh). The deploy route computes `providers` BEFORE the
# onboard starts/reuses the gateway — and a recovery deploy (the common case)
# runs with the gateway DOWN — so the connected set must NOT depend on
# `openshell provider get`, or tools would silently fail to attach at create.
CONNECTED_FILE="${DIFFRACT_CONNECTED_TOOLS:-/var/lib/diffract/connected-tools}"
OPENSHELL="${OPENSHELL_PATH:-openshell}"
MODE="${1:-providers}"
SANDBOX="${2:-${DIFFRACT_SANDBOX:-hermes}}"

if ! command -v jq >/dev/null 2>&1; then
  [ "$MODE" = "providers" ] && echo ""
  exit 0
fi

# Connected tools = the persistent connect-flow list (gateway-independent),
# filtered to entries still in the registry when the registry is available.
# Falls back to registry ∩ providers (needs the gateway) only when no list file
# exists yet — e.g. a tool connected out-of-band before this mechanism shipped.
connected_tools() {
  local t
  if [ -s "$CONNECTED_FILE" ]; then
    while IFS= read -r t; do
      t="$(printf '%s' "$t" | tr -d '[:space:]')"; [ -z "$t" ] && continue
      if [ -f "$REGISTRY" ]; then
        jq -e --arg n "$t" '.tools[]|select(.name==$n)' "$REGISTRY" >/dev/null 2>&1 && echo "$t"
      else
        echo "$t"
      fi
    done < "$CONNECTED_FILE" | sort -u
    return
  fi
  [ -f "$REGISTRY" ] || return 0
  for t in $(jq -r '.tools[].name' "$REGISTRY" 2>/dev/null); do
    "$OPENSHELL" provider get "$t" >/dev/null 2>&1 && echo "$t"
  done
}

tool_hosts()    { jq -r --arg n "$1" '.tools[]|select(.name==$n)|.apiHosts[]?'  "$REGISTRY" 2>/dev/null; }
tool_binaries() { jq -r --arg n "$1" '.tools[]|select(.name==$n)|.binaries[]?' "$REGISTRY" 2>/dev/null; }

case "$MODE" in
  providers)
    # comma-separated list of connected tool provider names (for the onboard to
    # attach at create via NEMOCLAW_SANDBOX_EXTRA_PROVIDERS)
    connected_tools | paste -sd, - 2>/dev/null
    ;;
  egress)
    for t in $(connected_tools); do
      binargs=(); while IFS= read -r b; do [ -n "$b" ] && binargs+=(--binary "$b"); done < <(tool_binaries "$t")
      while IFS= read -r h; do
        [ -z "$h" ] && continue
        # registry host is "host:port"; OpenShell endpoint wants "host:port:access"
        if "$OPENSHELL" policy update "$SANDBOX" --add-endpoint "${h}:full" "${binargs[@]}" --wait >/dev/null 2>&1; then
          echo "[tool-sync] egress allowed: $t -> $h"
        else
          echo "[tool-sync] WARN: failed to apply egress for $t -> $h"
        fi
      done < <(tool_hosts "$t")
    done
    ;;
  list)
    for t in $(connected_tools); do
      echo "connected: $t  hosts=[$(tool_hosts "$t" | paste -sd, -)]  binaries=[$(tool_binaries "$t" | paste -sd, -)]"
    done
    ;;
  *)
    echo "usage: $0 providers | egress [<sandbox>] | list" >&2; exit 2 ;;
esac
