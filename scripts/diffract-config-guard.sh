#!/bin/bash
# Keep the Hermes agent config.yaml readable by the sandbox-user gateway.
#
# Root cause: `hermes dashboard` runs as root and, on first dashboard load /
# settings normalization, rewrites /sandbox/.hermes/config.yaml. Without setgid
# on the dir, that root-written file lands root:root, which the sandbox-user
# `hermes gateway run` cannot read; on its next config reload it falls back to a
# default with no inference provider -> HTTP 500 "No inference provider configured".
#
# Fix (proactive, no race): setgid on /sandbox/.hermes so ANY root-written file
# inherits group=sandbox and stays group-readable -> the gateway can always read
# it. The chgrp backup covers a writer that explicitly chowns root:root.
# STOPGAP until the dashboard is launched as the sandbox user in the image.
set -u
DOCKER="${DOCKER_PATH:-docker}"
sandbox_name(){ jq -r '.defaultSandbox' ~/.nemoclaw/sandboxes.json 2>/dev/null; }
resolve_cid(){ "$DOCKER" ps -q -f "label=openshell.ai/managed-by=openshell" -f "label=openshell.ai/sandbox-name=$1" 2>/dev/null | head -1; }
echo "[config-guard] started (setgid + group=sandbox on /sandbox/.hermes/config.yaml)"
while true; do
  sb="$(sandbox_name)"; { [ -z "$sb" ] || [ "$sb" = "null" ]; } && { sleep 2; continue; }
  cid="$(resolve_cid "$sb")"; [ -z "$cid" ] && { sleep 2; continue; }
  "$DOCKER" exec "$cid" sh -c '
    d=/sandbox/.hermes; f=$d/config.yaml
    [ -d "$d" ] || exit 0
    # proactive: setgid so future root-written files inherit group=sandbox
    case "$(stat -c %A "$d" 2>/dev/null)" in *S*|*s*) : ;; *) chmod g+s "$d" 2>/dev/null && echo "[config-guard] set setgid on .hermes" ;; esac
    # backup: if config went non-sandbox group, restore it
    if [ -f "$f" ] && [ "$(stat -c %G "$f" 2>/dev/null)" != "sandbox" ]; then
      chgrp sandbox "$f" 2>/dev/null; chmod g+r "$f" 2>/dev/null
      echo "[config-guard] re-asserted group=sandbox on config.yaml"
    fi
  ' 2>/dev/null
  sleep 1
done
