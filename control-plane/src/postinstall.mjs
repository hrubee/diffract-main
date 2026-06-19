// ─────────────────────────────────────────────────────────────────────────────
// Post-install script generator.
//
// Hostinger runs the returned script as ROOT on the freshly-installed client VPS
// (output -> /post_install.log). It:
//   1. exports the install env, INCLUDING DIFFRACT_DOMAIN=<sub>.diffraction.in so
//      install.sh runs setup.sh WITH a domain — the box's own Caddy then gets a
//      Let's Encrypt cert and serves HTTPS directly (no central ingress),
//   2. curls + runs install.sh,
//   3. opens the public web ports (80 for the ACME HTTP-01 challenge + redirect,
//      443 for HTTPS) and keeps SSH; everything else stays default-deny,
//   4. injects the shared inference key and auto-deploys the agent so chat works
//      out of the box (operator chose Diffract-fronted inference).
//
// The control plane publishes the matching DNS A record as soon as the VM reports
// an IP; the box's Caddy retries ACME until that record resolves, so the two race
// harmlessly to completion. Kept under Hostinger's 48KB limit by curl-ing
// install.sh rather than embedding it; idempotent enough to survive a recreate.
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
 *   domain: string,                 // control domain, e.g. "diffraction.in"
 *   install: { installUrl: string, repo: string, branch: string, githubToken?: string },
 *   inject: { provider: string, key: string, model?: string },
 * }} args
 * @returns {string} bash script (<48KB)
 */
export function buildPostInstallScript({ subdomain, adminPassword, domain, install, inject }) {
  const keyEnv = providerKeyEnv(inject.provider);
  const fqdn = `${subdomain}.${domain}`;
  return `#!/usr/bin/env bash
# Diffract post-install for tenant ${fqdn} — runs as root on a fresh VPS.
set -euo pipefail
exec > >(tee -a /post_install.log) 2>&1
echo "[diffract-postinstall] start $(date -u +%FT%TZ)"

# ── 1. Install env -> install.sh runs setup with a DOMAIN (box owns its TLS) ───
export DIFFRACT_DOMAIN=${shq(fqdn)}
export DIFFRACT_ADMIN_PASSWORD=${shq(adminPassword)}
export DIFFRACT_REPO=${shq(install.repo)}
export DIFFRACT_BRANCH=${shq(install.branch)}
export DIFFRACT_DIR=/root/diffract-main
${install.githubToken ? `export GITHUB_TOKEN=${shq(install.githubToken)}\n` : ""}
# ── 2. Run the one-shot installer (DIFFRACT_DOMAIN => HTTPS via the box's Caddy) ─
curl -fsSL ${shq(install.installUrl)} | bash

# ── 3. Open the public web ports (the box serves its own HTTPS now) ───────────
# Caddy needs :80 (ACME HTTP-01 + HTTP->HTTPS redirect) and :443 (HTTPS). It
# proxies internally over localhost (/agent->:9119, /v1->:8642, else->:3000), so
# only 22/80/443 are ever exposed.
if command -v ufw >/dev/null 2>&1; then
  ufw --force reset || true
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH || ufw allow 22/tcp || true
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "[diffract-postinstall] ufw: 22/80/443 allowed; default deny"
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
