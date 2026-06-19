// ─────────────────────────────────────────────────────────────────────────────
// Config — read + validate every operator-supplied value at startup.
//
// Values come from the process environment (the systemd unit loads .env via
// EnvironmentFile; locally run with `node --env-file=.env src/server.mjs`).
// We FAIL FAST: if a required secret/id is missing the service refuses to boot,
// so a half-configured control plane never silently takes payments it can't
// fulfil.
// ─────────────────────────────────────────────────────────────────────────────

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

export const config = {
  port: int("PORT", { fallback: 8787 }),
  controlDomain: opt("CONTROL_DOMAIN", "diffraction.in"),
  // Public host the control plane itself answers on (Dodo posts webhooks here).
  // Covered by the *.diffraction.in wildcard, so no extra DNS record is needed.
  controlHost: opt("CONTROL_HOST", `cp.${opt("CONTROL_DOMAIN", "diffraction.in")}`),
  tenantStore: opt("TENANT_STORE", "./data/tenants.json"),
  adminApiToken: req("ADMIN_API_TOKEN"),

  dodo: {
    webhookSecret: req("DODO_WEBHOOK_SECRET"),
    apiKey: opt("DODO_API_KEY"),
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
    ingressIp: req("INGRESS_PUBLIC_IP"),
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

  caddy: {
    admin: opt("CADDY_ADMIN", "http://127.0.0.1:2019"),
    server: opt("CADDY_SERVER", "srv0"),
  },

  email: {
    smtpUrl: opt("SMTP_URL"),
    from: opt("SMTP_FROM", "Diffract <noreply@diffraction.in>"),
    support: opt("SUPPORT_EMAIL", "support@diffraction.in"),
  },
};

// Reserved subdomains — MUST mirror website/api/checkout.php + claim.php + signup.html.
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
