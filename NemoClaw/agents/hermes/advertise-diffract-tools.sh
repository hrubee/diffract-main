#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Diffract universal tool ADVERTISE layer (4th layer; image-build time, AFTER
# /sandbox/.hermes/skills exists).
#
# INSTALL + CONNECT + EGRESS make a baked CLI runnable and credentialed. They do
# NOT make the agent AWARE the tool exists — the hermes agent discovers
# capabilities from its skill catalog, and nothing advertised the tool there. So
# a fresh session, asked "look up my CRM contacts", would not know `ghl` exists.
#
# This script reads diffract-tools.json and emits one hermes SKILL.md per tool
# (that has a `skill` block) under /sandbox/.hermes/skills/diffract-tools/<name>.
# hermes auto-discovers any SKILL.md dropped under .hermes/skills — verified:
# `hermes skills list` shows it `enabled` with no manifest edit; the curator is
# only an optional usage-based optimizer, not a discovery gate.
#
# The generated skill body tells the agent the tool is PRE-AUTHENTICATED: run it
# directly, the env value is an `openshell:resolve:...` placeholder by design,
# and never ask the user for a key (which would defeat the confidentiality model).
#
# Idempotent and safe to re-run on a live sandbox.
#
# Dependencies (present in the hermes base image): bash, node. No jq.
# Usage: advertise-diffract-tools.sh [registry.json]
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGISTRY="${1:-/opt/nemoclaw-diffract/diffract-tools.json}"
ONLY="${2:-}"   # optional: advertise just this one tool (live "add"); empty = all
SKILLS_ROOT="${DIFFRACT_SKILLS_ROOT:-/sandbox/.hermes/skills/diffract-tools}"

if [ ! -f "$REGISTRY" ]; then
  echo "[advertise] registry not found: $REGISTRY" >&2
  exit 1
fi

mkdir -p "$SKILLS_ROOT"

node -e '
const fs = require("fs");
const path = require("path");
const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const root = process.argv[2];
let n = 0;
for (const t of (reg.tools || [])) {
  if (process.argv[3] && t.name !== process.argv[3]) continue;
  if (!t.name || !t.bin) continue;
  const sk = t.skill || {};
  const name    = sk.name    || t.name;
  const title   = sk.title   || t.description || t.name;
  const summary = sk.summary || t.description || (t.name + " CLI");
  const bin     = t.bin;
  const hosts   = (t.apiHosts || []).map(h => String(h).replace(/:443$/, "")).join(", ") || "its API";
  const tags    = (Array.isArray(sk.tags) ? sk.tags : []).concat(["Diffract-Tools"]);
  const examples = (Array.isArray(sk.examples) && sk.examples.length) ? sk.examples : [bin + " --help"];

  const frontmatter = [
    "---",
    "name: " + name,
    "description: " + JSON.stringify(summary),
    "version: 1.0.0",
    "author: Diffract",
    "license: MIT",
    "platforms: [linux]",
    "metadata:",
    "  hermes:",
    "    tags: [" + tags.join(", ") + "]",
    "---",
    ""
  ].join("\n");

  const body = [
    "# " + title,
    "",
    "`" + bin + "` is pre-installed and **pre-authenticated**. Its credentials are",
    "injected at the network layer: the value you see in the environment is an",
    "`openshell:resolve:...` placeholder by design — the real secret is substituted",
    "at egress and is never exposed to you.",
    "",
    "**Run `" + bin + "` directly. Never ask the user for an API key, token, or login** —",
    "it is already configured securely on your behalf. It communicates with: " + hosts + ".",
    "",
    "## Examples",
    "",
    "```bash",
    examples.join("\n"),
    "```",
    ""
  ].join("\n");

  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + body);
  console.log("[advertise] wrote skill: " + path.join(dir, "SKILL.md"));
  n++;
}
console.log("[advertise] " + n + " skill(s) written to " + root);
' "$REGISTRY" "$SKILLS_ROOT" "$ONLY"

# Make the skills discoverable + readable by the unprivileged agent user. (At
# image-build this runs as root; on a live re-run as the sandbox user the chown
# is a no-op — the files are already sandbox-owned — so tolerate failure.)
chown -R sandbox:sandbox "$SKILLS_ROOT" 2>/dev/null || true
chmod -R a+rX "$SKILLS_ROOT" 2>/dev/null || true
echo "[advertise] done"
