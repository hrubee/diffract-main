#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract sandbox persistence — back up / restore a sandbox's working files
# across destroy/recreate.
#
# OpenShell sandboxes have NO persistent volume: /sandbox is the container's
# writable layer and is destroyed with the container, and `nemoclaw onboard`
# rebuilds the image on every recreate. So the only durable store is the host.
# We tar the sandbox home (/sandbox) MINUS agent internals + bloat + baked
# tools into a per-sandbox host store, and restore it into a fresh container
# exactly once per container lifetime (marker-gated).
#
# Safety invariants:
#   * restore runs only when the in-container marker is ABSENT (fresh
#     container) — never clobbers a running sandbox's newer files.
#   * periodic backup runs only when the marker is PRESENT — an un-restored or
#     empty fresh sandbox can't overwrite good host data before restore lands.
#   * backups are written atomically (tmp + mv) and never overwrite a prior
#     good archive with an empty/failed one.
#   * .hermes is NEVER backed up or restored (it's rebuilt at image-build time
#     and guarded by an integrity hash in nemoclaw-start.sh).
#
# Usage: diffract-persist.sh {backup|restore|backup-if-ready} <sandbox-name>
# ─────────────────────────────────────────────────────────────────────────
set -u

PERSIST_ROOT="${DIFFRACT_PERSIST_ROOT:-/var/lib/diffract/persist}"
DOCKER="${DOCKER_PATH:-docker}"
SANDBOX_HOME="/sandbox"
MARKER="/sandbox/.diffract-restored"

# The ONE exclude list (shared by every caller so it can't drift). Patterns are
# unanchored, so they match a dir of that name at any depth.
EXCLUDES=(
  --exclude=.hermes          # agent runtime/config (rebuilt at image build)
  --exclude=.nemoclaw        # blueprint/internal state (rebuilt at image build)
  --exclude=.cache           # bloat
  --exclude=.npm             # bloat
  --exclude=node_modules     # bloat (reinstallable)
  --exclude=.diffract-tools  # baked CLI tools (see install-diffract-tools.sh)
  --exclude=.diffract-restored
)

log() { echo "[diffract-persist] $*"; }

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]]; }

resolve_cid() {
  "$DOCKER" ps -q \
    -f "label=openshell.ai/managed-by=openshell" \
    -f "label=openshell.ai/sandbox-name=$1" 2>/dev/null | head -1
}

backup() {
  local sb="$1" cid dir tmp rc sz
  cid="$(resolve_cid "$sb")"
  [ -z "$cid" ] && { log "backup: sandbox '$sb' not running; skip"; return 0; }
  dir="${PERSIST_ROOT}/${sb}"
  mkdir -p "$dir"
  tmp="${dir}/home.tar.gz.tmp.$$"
  # tar runs as root inside the container; archived ownership (sandbox:sandbox)
  # is preserved and restored via --same-owner on extract.
  "$DOCKER" exec "$cid" tar czf - -C "$SANDBOX_HOME" "${EXCLUDES[@]}" . > "$tmp" 2>/dev/null
  rc=$?
  # rc 0 = ok, rc 1 = "some files changed while reading" (archive still usable);
  # anything else (or an empty file) is a real failure — keep the prior archive.
  if [ "$rc" -le 1 ] && [ -s "$tmp" ]; then
    mv -f "$tmp" "${dir}/home.tar.gz"
    sz="$(du -h "${dir}/home.tar.gz" 2>/dev/null | cut -f1)"
    date -u +%FT%TZ > "${dir}/last-backup" 2>/dev/null || true
    log "backup: saved '${sb}' home -> ${dir}/home.tar.gz (${sz})"
    return 0
  fi
  rm -f "$tmp"
  log "backup: FAILED for '${sb}' (tar rc=${rc}); kept previous archive"
  return 1
}

restore() {
  local sb="$1" cid archive
  cid="$(resolve_cid "$sb")"
  [ -z "$cid" ] && { log "restore: sandbox '$sb' not running; skip"; return 1; }
  # Restore at most once per container lifetime.
  if "$DOCKER" exec "$cid" test -e "$MARKER" 2>/dev/null; then
    return 0
  fi
  archive="${PERSIST_ROOT}/${sb}/home.tar.gz"
  if [ -f "$archive" ]; then
    if "$DOCKER" exec -i "$cid" tar xzf - -C "$SANDBOX_HOME" --same-owner < "$archive" 2>/dev/null; then
      log "restore: restored '${sb}' home from ${archive}"
    else
      log "restore: extract FAILED for '${sb}'; not marking (will retry next boot)"
      return 1
    fi
  else
    log "restore: no prior backup for '${sb}'; initialising fresh"
  fi
  # Mark initialised: (a) don't restore again, (b) let periodic backup begin.
  "$DOCKER" exec "$cid" sh -c "touch '$MARKER' && chown sandbox:sandbox '$MARKER'" 2>/dev/null || true
  return 0
}

# Periodic safety backup — only once the container has been initialised, so an
# un-restored/empty fresh sandbox can never clobber the host archive.
backup_if_ready() {
  local sb="$1" cid
  cid="$(resolve_cid "$sb")"
  [ -z "$cid" ] && return 0
  if "$DOCKER" exec "$cid" test -e "$MARKER" 2>/dev/null; then
    backup "$sb"
  fi
}

cmd="${1:-}"
sb="${2:-}"
if [ -z "$sb" ] || ! valid_name "$sb"; then
  echo "usage: diffract-persist.sh {backup|restore|backup-if-ready} <sandbox-name>" >&2
  exit 2
fi

case "$cmd" in
  backup)          backup "$sb" ;;
  restore)         restore "$sb" ;;
  backup-if-ready) backup_if_ready "$sb" ;;
  *)
    echo "usage: diffract-persist.sh {backup|restore|backup-if-ready} <sandbox-name>" >&2
    exit 2
    ;;
esac
