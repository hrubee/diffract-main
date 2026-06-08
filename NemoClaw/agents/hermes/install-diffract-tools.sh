#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract universal tool installer (image build time).
#
# Reads diffract-tools.json and bakes each listed CLI into
# /sandbox/.diffract-tools/<name>, then symlinks its entrypoint onto the
# agent's PATH at /usr/local/bin/<bin>.
#
# WHY /sandbox (not /opt): OpenShell confines the sandboxed agent's filesystem
# reads to its home (/sandbox) and runtime (/opt/hermes). A tool under an
# arbitrary path is unreadable by the agent even when world-readable. The
# file-persistence backup (scripts/diffract-persist.sh) excludes
# /sandbox/.diffract-tools so a restore never clobbers the baked copies.
#
# Adding a tool = one entry in diffract-tools.json. No code change here.
#
# Dependencies (all present in the hermes base image): bash, git, node.
# JSON is parsed with node (no jq dependency). `build` strings come from the
# in-repo registry (trusted), so eval-ing them is intentional.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGISTRY="${1:-/opt/nemoclaw-diffract/diffract-tools.json}"
ROOT=/sandbox/.diffract-tools

if [ ! -f "$REGISTRY" ]; then
  echo "[diffract-tools] registry not found: $REGISTRY" >&2
  exit 1
fi

mkdir -p "$ROOT"

# Emit one TAB-separated line per tool: name<TAB>repo<TAB>ref<TAB>build<TAB>entry<TAB>bin
TOOLS="$(node -e '
const fs = require("fs");
const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const t of (reg.tools || [])) {
  if (!t.name || !t.repo || !t.entry) {
    process.stderr.write("[diffract-tools] skipping malformed entry: " + JSON.stringify(t) + "\n");
    continue;
  }
  const bin = t.bin || t.name;
  const ref = t.ref || "main";
  const build = t.build || "";
  process.stdout.write([t.name, t.repo, ref, build, t.entry, bin].join("\t") + "\n");
}' "$REGISTRY")"

if [ -z "$TOOLS" ]; then
  echo "[diffract-tools] no tools to install"
else
  printf '%s\n' "$TOOLS" | while IFS=$'\t' read -r name repo ref build entry bin; do
    [ -z "$name" ] && continue
    dir="$ROOT/$name"
    echo "[diffract-tools] installing '$name' from $repo@$ref"
    rm -rf "$dir"
    git clone --depth 1 --branch "$ref" "$repo" "$dir"
    if [ -n "$build" ]; then
      ( cd "$dir" && eval "$build" )
    fi
    ln -sf "$dir/$entry" "/usr/local/bin/$bin"
    chmod +x "$dir/$entry"
    rm -rf "$dir/.git"
    echo "[diffract-tools] installed '$name' -> /usr/local/bin/$bin"
  done
fi

# Tidy + make everything readable/executable by the unprivileged agent user.
rm -rf /root/.npm
chown -R sandbox:sandbox "$ROOT"
chmod -R a+rX "$ROOT"
echo "[diffract-tools] done"
