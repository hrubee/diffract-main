// ─────────────────────────────────────────────────────────────────────────────
// Config — read + validate every operator-supplied value at startup.
//
// Values come from the process environment (the systemd unit loads .env via
// EnvironmentFile; locally run with `node --env-file=.env src/server.mjs`).
// We FAIL FAST: if a required secret/id is missing the service refuses to boot,
// so a half-configured control plane never silently takes payments it can't
// fulfil.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";

function req(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`[config] missing required env: ${name} (see control-plane/.env.example)`);
  }
  return v;
}

function opt(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name, { required = false, fallback = 0 } = {}) {
  const raw = required ? req(name) : opt(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`[config] env ${name} must be an integer, got: ${raw}`);
  return n;
}

const CONTROL_DOMAIN = opt("CONTROL_DOMAIN", "diffraction.in");
const CONTROL_HOST = opt("CONTROL_HOST", `cp.${CONTROL_DOMAIN}`);

export const config = {
  port: int("PORT", { fallback: 8787 }),
  // Bind 0.0.0.0 on Railway (the service is public-facing now — it serves the
  // signup page + receives Dodo webhooks directly, no Caddy in front).
  bindHost: opt("BIND_HOST", "0.0.0.0"),
  controlDomain: CONTROL_DOMAIN,
  controlHost: CONTROL_HOST,
  // Where the signup page is publicly served (Dodo return_url + welcome email link).
  publicBaseUrl: opt("PUBLIC_BASE_URL", `https://${CONTROL_HOST}`),
  // Static site root (the signup/checkout page). Defaults to ../public.
  webRoot: opt("WEB_ROOT", path.resolve(import.meta.dirname, "..", "public")),
  tenantStore: opt("TENANT_STORE", "./data/tenants.json"),
  adminApiToken: req("ADMIN_API_TOKEN"),

  dodo: {
    webhookSecret: req("DODO_WEBHOOK_SECRET"),
    apiKey: opt("DODO_API_KEY"),
    // The subscription product the signup page sells (Diffract, ₹2,500/mo LIVE).
    productId: opt("DODO_PRODUCT_ID"),
    base: opt("DODO_BASE", "https://live.dodopayments.com"),
  },

  hostinger: {
    token: req("HOSTINGER_API_TOKEN"),
    base: opt("HOSTINGER_API_BASE", "https://developers.hostinger.com"),
    itemId: req("HOSTINGER_ITEM_ID"),
    templateId: int("HOSTINGER_TEMPLATE_ID", { required: true }),
    dataCenterId: int("HOSTINGER_DATACENTER_ID", { required: true }),
    // 0 => omit from request so Hostinger uses the account default.
    paymentMethodId: int("HOSTINGER_PAYMENT_METHOD_ID"),
    enableBackups: bool("HOSTINGER_ENABLE_BACKUPS", false),
  },

  install: {
    installUrl: opt("DIFFRACT_INSTALL_URL",
      "https://raw.githubusercontent.com/hrubee/diffract-main/main/install.sh"),
    repo: opt("DIFFRACT_REPO", "https://github.com/hrubee/diffract-main"),
    branch: opt("DIFFRACT_BRANCH", "main"),
    githubToken: opt("DIFFRACT_GITHUB_TOKEN"),
  },

  inject: {
    provider: opt("INJECT_PROVIDER", "nvidia"),
    key: req("INJECT_INFERENCE_KEY"),
    model: opt("INJECT_MODEL", ""),
  },

  // DNS — how <client>.diffraction.in is pointed at each provisioned box.
  // Default "hostinger" reuses the VPS API token (domain + VPSs in one account).
  dns: {
    provider: opt("DNS_PROVIDER", "hostinger"),
    domain: CONTROL_DOMAIN,
    ttl: int("DNS_TTL", { fallback: 300 }),
    hostinger: {
      token: opt("HOSTINGER_DNS_TOKEN", opt("HOSTINGER_API_TOKEN")),
      base: opt("HOSTINGER_API_BASE", "https://developers.hostinger.com"),
    },
    cloudflare: {
      token: opt("CLOUDFLARE_API_TOKEN"),
      zoneId: opt("CLOUDFLARE_ZONE_ID"),
      base: opt("CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4"),
    },
  },

  email: {
    smtpUrl: opt("SMTP_URL"),
    from: opt("SMTP_FROM", "Diffract <noreply@diffraction.in>"),
    support: opt("SUPPORT_EMAIL", "support@diffraction.in"),
  },
};

// Reserved subdomains — MUST mirror public/signup.html's RESERVED set.
export const RESERVED_SUBDOMAINS = new Set([
  "app", "www", "ftp", "api", "admin", "mail", "root", "ns", "ns1", "ns2", "cdn",
  "static", "assets", "dashboard", "status", "blog", "support", "help", "docs",
  "console", "portal", "login", "signup", "sign-up", "dev", "staging", "test",
  "demo", "mx", "smtp", "webmail", "vpn", "git", "acme", "cp", "control",
]);

export function isValidSubdomain(sub) {
  return typeof sub === "string"
    && /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$/.test(sub)
    && !RESERVED_SUBDOMAINS.has(sub);
}
