// ─────────────────────────────────────────────────────────────────────────────
// Post-install script generator.
//
// Hostinger runs the returned script as ROOT on the freshly-installed client VPS
// (output -> /post_install.log). It:
//   1. exports the install env (admin password, repo/branch, optional PAT),
//   2. curls + runs install.sh in --vps mode (no public domain — the central
//      ingress terminates TLS for <sub>.diffraction.in and reverse-proxies in),
//   3. locks the public surface (port 80, where the box's own Caddy does the
//      /agent + /v1 routing) so ONLY the ingress IP can reach it,
//   4. injects the shared inference key and auto-deploys the agent so chat works
//      out of the box (operator chose Diffract-fronted inference).
//
// Kept under Hostinger's 48KB limit by curl-ing install.sh rather than embedding
// it. The script is idempotent enough to be re-run by a recreate.
// ─────────────────────────────────────────────────────────────────────────────

// provider name -> the env var the agent stack expects the key under.
function providerKeyEnv(provider) {
  const p = String(provider).toLowerCase();
  if (p === "nvidia" || p === "nvidia-prod") return "NVIDIA_API_KEY";
  if (p === "anthropic") return "ANTHROPIC_API_KEY";
  if (p === "openai") return "OPENAI_API_KEY";
  return `${p.replace(/[^a-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

// Single-quote a value for safe embedding in the generated bash.
function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{
 *   subdomain: string,
 *   adminPassword: string,
 *   ingressIp: string,
 *   install: { installUrl: string, repo: string, branch: string, githubToken?: string },
 *   inject: { provider: string, key: string, model?: string },
 * }} args
 * @returns {string} bash script (<48KB)
 */
export function buildPostInstallScript({ subdomain, adminPassword, ingressIp, install, inject }) {
  const keyEnv = providerKeyEnv(inject.provider);
  return `#!/usr/bin/env bash
# Diffract post-install for tenant ${subdomain} — runs as root on a fresh VPS.
set -euo pipefail
exec > >(tee -a /post_install.log) 2>&1
echo "[diffract-postinstall] start $(date -u +%FT%TZ)"

# ── 1. Install env -> install.sh runs setup in --vps mode (ingress owns TLS) ──
export DIFFRACT_ADMIN_PASSWORD=${shq(adminPassword)}
export DIFFRACT_REPO=${shq(install.repo)}
export DIFFRACT_BRANCH=${shq(install.branch)}
export DIFFRACT_DIR=/root/diffract-main
${install.githubToken ? `export GITHUB_TOKEN=${shq(install.githubToken)}\n` : ""}
# ── 2. Run the one-shot installer (no positional domain => --vps mode) ────────
curl -fsSL ${shq(install.installUrl)} | bash

# ── 3. Lock the public surface (:80) to the ingress only ─────────────────────
# The box's Caddy serves everything on :80 (it routes /agent->:9119, /v1->:8642,
# else ->:3000 internally over localhost). So only :80 must be reachable, and
# only from the central ingress.
INGRESS_IP=${shq(ingressIp)}
if command -v ufw >/dev/null 2>&1; then
  ufw --force reset || true
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH || ufw allow 22/tcp || true
  ufw allow from "$INGRESS_IP" to any port 80 proto tcp
  ufw --force enable
  echo "[diffract-postinstall] ufw: port 80 allowed from $INGRESS_IP only"
fi

# ── 4. Inject the shared inference key + auto-deploy so chat works OOTB ───────
# The dashboard reads provider keys from /etc/diffractui.env; add ours, then drive
# the existing deploy route (login -> GET /api/deploy) to onboard the agent.
KEY_LINE=${shq(`${keyEnv}=${inject.key}`)}
if ! grep -q "^${keyEnv}=" /etc/diffractui.env 2>/dev/null; then
  echo "$KEY_LINE" >> /etc/diffractui.env
fi
systemctl restart diffractui 2>/dev/null || true

# Wait for the dashboard, then trigger a deploy with the injected provider/model.
PROVIDER=${shq(inject.provider)}
MODEL=${shq(inject.model || "")}
for i in $(seq 1 60); do
  if curl -fsS -m 3 http://127.0.0.1:3000/api/status >/dev/null 2>&1; then break; fi
  sleep 5
done
COOKIE=$(mktemp)
if curl -fsS -m 10 -c "$COOKIE" -X POST http://127.0.0.1:3000/api/auth/login \\
      -H 'Content-Type: application/json' \\
      -d "{\\"password\\":\\"$DIFFRACT_ADMIN_PASSWORD\\"}" >/dev/null 2>&1; then
  DEPLOY_URL="http://127.0.0.1:3000/api/deploy?provider=$PROVIDER&sandboxName=test"
  [ -n "$MODEL" ] && DEPLOY_URL="$DEPLOY_URL&model=$(printf '%s' "$MODEL" | sed 's,/,%2F,g')"
  # SSE stream; cap the time so post-install always returns.
  curl -fsS -m 900 -b "$COOKIE" "$DEPLOY_URL" >/dev/null 2>&1 || \\
    echo "[diffract-postinstall] WARN: auto-deploy did not complete cleanly (deploy from dashboard)"
else
  echo "[diffract-postinstall] WARN: dashboard login failed — deploy the agent from the dashboard"
fi
rm -f "$COOKIE"

echo "[diffract-postinstall] done $(date -u +%FT%TZ)"
`;
}
