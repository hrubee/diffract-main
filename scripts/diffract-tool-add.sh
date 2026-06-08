#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract live tool "add" — install + advertise ONE registry tool into the
# RUNNING sandbox, so a tool added from the diffractui Tools tab is usable
# immediately (no image rebuild / recreate). The same registry entry also
# re-bakes on the next recreate, so this is durable, not a one-off.
#
# Run on the HOST (the diffractui Tools API spawns it detached, redirecting
# output to a log the status endpoint polls). It:
#   1. copies the updated registry into the sandbox container,
#   2. runs the baked install-diffract-tools.sh for just <tool> (clone+build
#      into /sandbox/.diffract-tools/<tool>, symlink onto PATH),
#   3. runs the baked advertise-diffract-tools.sh for just <tool> (SKILL.md),
#   4. reloads the agent's skill index so the running gateway sees it.
#
# Progress is logged with [add] prefixes; the LAST line is always
# "===DONE rc=N===" so the poller can detect completion + success.
#
# Usage: diffract-tool-add.sh <sandbox> <tool> [registry.json]
# ─────────────────────────────────────────────────────────────────────────
set -u

SANDBOX="${1:-}"
TOOL="${2:-}"
REGISTRY="${3:-/usr/local/share/diffract/diffract-tools.json}"
DOCKER="${DOCKER_PATH:-docker}"

log() { echo "[add] $*"; }
done_marker() { echo "===DONE rc=$1==="; exit "$1"; }

if [ -z "$SANDBOX" ] || [ -z "$TOOL" ]; then
  log "usage: diffract-tool-add.sh <sandbox> <tool> [registry.json]"
  done_marker 2
fi
if [ ! -f "$REGISTRY" ]; then
  log "registry not found: $REGISTRY"
  done_marker 1
fi

cid="$("$DOCKER" ps -q \
  -f "label=openshell.ai/managed-by=openshell" \
  -f "label=openshell.ai/sandbox-name=$SANDBOX" 2>/dev/null | head -1)"
if [ -z "$cid" ]; then
  log "sandbox '$SANDBOX' is not running"
  done_marker 1
fi

log "copying registry into sandbox"
"$DOCKER" cp "$REGISTRY" "$cid":/tmp/diffract-tools.json || done_marker 1

# The running sandbox's BAKED install/advertise scripts may predate the
# single-tool (--only) support. Ship the current scripts (they live next to the
# registry, or in the repo) into the sandbox and run those; fall back to the
# baked copies only if the current ones can't be found on the host.
REG_DIR="$(cd "$(dirname "$REGISTRY")" 2>/dev/null && pwd || echo /nonexistent)"
INSTALL_RUN=/usr/local/bin/install-diffract-tools.sh
ADVERTISE_RUN=/usr/local/bin/advertise-diffract-tools.sh
for d in "$REG_DIR" /root/diffract-main/NemoClaw/agents/hermes; do
  if [ -f "$d/install-diffract-tools.sh" ] && [ -f "$d/advertise-diffract-tools.sh" ]; then
    "$DOCKER" cp "$d/install-diffract-tools.sh" "$cid":/tmp/install-diffract-tools.sh && \
    "$DOCKER" cp "$d/advertise-diffract-tools.sh" "$cid":/tmp/advertise-diffract-tools.sh && {
      INSTALL_RUN=/tmp/install-diffract-tools.sh
      ADVERTISE_RUN=/tmp/advertise-diffract-tools.sh
      log "using current install/advertise scripts from $d"
    }
    break
  fi
done

log "installing '$TOOL' into the sandbox (git clone + build — this can take a minute)…"
"$DOCKER" exec "$cid" bash "$INSTALL_RUN" /tmp/diffract-tools.json "$TOOL" || {
  log "install failed for '$TOOL'"
  done_marker 1
}

log "advertising '$TOOL' as an agent skill"
"$DOCKER" exec "$cid" bash "$ADVERTISE_RUN" /tmp/diffract-tools.json "$TOOL" || {
  log "advertise failed for '$TOOL'"
  done_marker 1
}

# Best-effort: drop the cached skills system-prompt snapshot so a new agent
# session picks up the new skill (running sessions still need reload_skills).
"$DOCKER" exec -u sandbox -e HOME=/sandbox "$cid" \
  sh -lc 'rm -f /sandbox/.hermes/skills/.skills_prompt_snapshot.json 2>/dev/null' >/dev/null 2>&1 || true

log "'$TOOL' installed and advertised. Connect its credentials next, then it's ready."
done_marker 0
