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
# filtered to entries still in the registry when the registry is available AND
# belonging to THIS sandbox. Records are "tool:sandbox" so a tool connected to
# one box is never attached to another. Legacy bare "tool" entries (pre per-box
# isolation) are treated as belonging to the default sandbox so they don't leak
# into newly-created boxes. Falls back to registry ∩ providers (needs the gateway)
# only when no list file exists yet.
connected_tools() {
  local line t sbx defsb
  defsb="$(jq -r '.defaultSandbox // empty' "$HOME/.nemoclaw/sandboxes.json" 2>/dev/null)"
  if [ -s "$CONNECTED_FILE" ]; then
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | tr -d '[:space:]')"; [ -z "$line" ] && continue
      case "$line" in
        *:*) t="${line%:*}"; sbx="${line##*:}" ;;
        *)   t="$line";      sbx="$defsb" ;;   # legacy entry -> default sandbox
      esac
      [ "$sbx" = "$SANDBOX" ] || continue       # only THIS sandbox's tools
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

# Include a provider UNLESS OpenShell is reachable AND positively reports it
# missing. A record can outlive its OpenShell provider (deleted out-of-band) —
# emitting that stale name makes onboard's attach hard-fail at create with
# "provider 'X' not found and 'X' is not a recognized provider type", which aborts
# the whole deploy *after the sandbox is destroyed*. Dropping it lets the deploy
# finish (the affected tool just isn't attached until reconnected). We still emit
# when OpenShell itself can't be queried, preserving the gateway-independent
# behaviour the connected-tools file was designed for.
provider_present_or_unknown() {
  "$OPENSHELL" provider get  "$1" >/dev/null 2>&1 && return 0   # provider exists -> include
  "$OPENSHELL" provider list      >/dev/null 2>&1 && return 1   # OpenShell up but provider absent -> skip stale
  return 0                                                      # OpenShell unreachable -> include (don't lose tools)
}

case "$MODE" in
  providers)
    # comma-separated list of connected tool provider names (for the onboard to
    # attach at create via NEMOCLAW_SANDBOX_EXTRA_PROVIDERS), minus any whose
    # OpenShell provider no longer exists (would hard-fail the attach).
    connected_tools | while IFS= read -r t; do
      [ -n "$t" ] && provider_present_or_unknown "$t" && echo "$t"
    done | paste -sd, - 2>/dev/null
    ;;
  egress)
    # Exit non-zero if ANY tool's egress failed to apply, so the caller (the
    # deploy route) can surface it instead of reporting a clean deploy while a
    # tool's API stays blocked. rc stays 0 only if every endpoint applied.
    rc=0
    for t in $(connected_tools); do
      binargs=(); while IFS= read -r b; do [ -n "$b" ] && binargs+=(--binary "$b"); done < <(tool_binaries "$t")
      # The chat daemon's egress is cross-netns, so the proxy can't trace it to a
      # binary and attributes it as `-`; allow it or the tool won't work in chat.
      binargs+=(--binary "-")
      while IFS= read -r h; do
        [ -z "$h" ] && continue
        # registry host is "host:port"; OpenShell endpoint wants "host:port:access:protocol".
        # `:rest` makes the proxy TLS-terminate so it can SUBSTITUTE the credential
        # placeholder at egress (a `:full` tunnel can't, so the opaque token would leak
        # and cross-netns CONNECTs get denied). Same --rule-name as diffract-tool-connect.sh
        # ("<tool>-api") so a re-run UPDATES that rule instead of appending a duplicate.
        if "$OPENSHELL" policy update "$SANDBOX" --add-endpoint "${h}:full:rest" --rule-name "${t}-api" "${binargs[@]}" --wait >/dev/null 2>&1; then
          echo "[tool-sync] egress allowed: $t -> $h"
        else
          echo "[tool-sync] WARN: failed to apply egress for $t -> $h"
          rc=1
        fi
      done < <(tool_hosts "$t")
    done
    exit $rc
    ;;
  list)
    for t in $(connected_tools); do
      echo "connected: $t  hosts=[$(tool_hosts "$t" | paste -sd, -)]  binaries=[$(tool_binaries "$t" | paste -sd, -)]"
    done
    ;;
  *)
    echo "usage: $0 providers [<sandbox>] | egress [<sandbox>] | list [<sandbox>]" >&2; exit 2 ;;
esac
