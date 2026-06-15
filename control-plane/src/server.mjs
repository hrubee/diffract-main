// ─────────────────────────────────────────────────────────────────────────────
// Control-plane HTTP server.
//
// Routes:
//   POST /webhooks/dodo        verify Standard-Webhooks sig + idempotency, then
//                              provision/deprovision in the background, ACK fast
//                              (provisioning takes minutes; Dodo must get a 2xx now)
//   GET  /api/available        subdomain availability (for the signup page)
//   GET  /tls/ask              Caddy on-demand-TLS gate (only issue for tenants)
//   GET  /healthz              liveness
//   GET  /internal/tenants     ops list (Bearer ADMIN_API_TOKEN)
//   POST /internal/retry       re-run provisioning for a subdomain (Bearer)
//
// Fronted by the central Caddy (TLS); this listens on 127.0.0.1:PORT.
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import { config, isValidSubdomain } from "./config.mjs";
import { TenantStore } from "./tenants.mjs";
import { Hostinger } from "./hostinger.mjs";
import { Caddy } from "./caddy.mjs";
import { Provisioner } from "./provisioner.mjs";
import { verifyWebhook, parseEvent } from "./dodo.mjs";
import { sendWelcome } from "./email.mjs";
import path from "node:path";

const MAX_BODY = 1_000_000; // 1 MB cap on webhook bodies

const store = new TenantStore(config.tenantStore);
const hostinger = new Hostinger({ token: config.hostinger.token, base: config.hostinger.base });
const caddy = new Caddy({ admin: config.caddy.admin, server: config.caddy.server });
const outboxDir = path.join(path.dirname(path.resolve(config.tenantStore)), "outbox");
const emailFn = (to, { subdomain, url, adminPassword }) =>
  sendWelcome(config.email, { to, subdomain, url, adminPassword, outboxDir });

const provisioner = new Provisioner({ config, store, hostinger, caddy, email: emailFn });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", ...extraHeaders });
  res.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": `https://${config.controlDomain}`,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function bearerOk(req) {
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${config.adminApiToken}`;
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const headers = {
    "webhook-id": req.headers["webhook-id"],
    "webhook-timestamp": req.headers["webhook-timestamp"],
    "webhook-signature": req.headers["webhook-signature"],
  };
  const v = verifyWebhook({ headers, rawBody, secret: config.dodo.webhookSecret });
  if (!v.ok) {
    console.warn(`[webhook] rejected: ${v.reason}`);
    return json(res, 401, { error: "invalid signature", reason: v.reason });
  }

  // Idempotency: Dodo delivers at-least-once. First-seen ids only proceed.
  const fresh = await store.markProcessed(headers["webhook-id"]);
  if (!fresh) return json(res, 200, { ok: true, dedup: true });

  let body;
  try { body = JSON.parse(rawBody); } catch { return json(res, 400, { error: "bad json" }); }
  const ev = parseEvent(body);
  console.log(`[webhook] ${ev.type} action=${ev.action} sub=${ev.subdomain || "-"} subId=${ev.subscriptionId || "-"}`);

  // Validate + dispatch in the background; ACK now so Dodo doesn't retry a
  // multi-minute provision.
  if (ev.action === "provision") {
    if (!isValidSubdomain(ev.subdomain)) {
      console.error(`[webhook] paid event with invalid/missing subdomain: "${ev.subdomain}" — needs manual fulfilment`);
      // Still 200 (the payment is real); record a pending row for ops.
      await store.upsert(ev.subdomain || `unknown-${ev.subscriptionId}`, {
        status: "failed", email: ev.email, dodoSubscriptionId: ev.subscriptionId,
        dodoCustomerId: ev.customerId, error: "invalid or missing subdomain in metadata",
      });
      return json(res, 200, { ok: true, queued: false, reason: "invalid subdomain" });
    }
    provisioner.provision(ev).catch((e) => console.error(`[webhook] provision failed: ${e.message}`));
  } else if (ev.action === "deprovision") {
    provisioner.deprovision(ev.subscriptionId).catch((e) => console.error(`[webhook] deprovision failed: ${e.message}`));
  } else if (ev.action === "renew") {
    if (ev.subscriptionId) {
      const t = await store.findBySubscription(ev.subscriptionId);
      if (t) await store.patch(t.subdomain, { currentPeriodEnd: ev.currentPeriodEnd, status: t.status === "suspended" ? "active" : t.status });
    }
  }
  return json(res, 200, { ok: true, queued: ev.action !== "ignore", action: ev.action });
}

async function handleAvailable(res, url) {
  const sub = String(url.searchParams.get("subdomain") ?? "").toLowerCase().trim();
  const headers = corsHeaders();
  if (!isValidSubdomain(sub)) {
    return json(res, 200, { available: false, reason: "invalid or reserved name" }, headers);
  }
  const existing = await store.get(sub);
  const taken = existing && existing.status !== "deprovisioned";
  return json(res, 200, { available: !taken, reason: taken ? "already taken" : "" }, headers);
}

async function handleTlsAsk(res, url) {
  // Caddy asks before issuing a cert for `domain`. Allow ONLY the control host
  // and live tenant subdomains, so nobody can make us mint certs for any host.
  const domain = String(url.searchParams.get("domain") ?? "").toLowerCase();
  if (domain === config.controlHost) { res.writeHead(200); return res.end("ok"); }
  const suffix = `.${config.controlDomain}`;
  if (domain.endsWith(suffix)) {
    const sub = domain.slice(0, -suffix.length);
    const t = await store.get(sub);
    if (t && (t.status === "active" || t.status === "provisioning")) { res.writeHead(200); return res.end("ok"); }
  }
  res.writeHead(404); res.end("no");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;

    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "POST" && pathname === "/webhooks/dodo") return await handleWebhook(req, res);
    if (req.method === "GET" && pathname === "/api/available") return await handleAvailable(res, url);
    if (req.method === "GET" && pathname === "/tls/ask") return await handleTlsAsk(res, url);

    if (pathname.startsWith("/internal/")) {
      if (!bearerOk(req)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && pathname === "/internal/tenants") return json(res, 200, { tenants: await store.list() });
      if (req.method === "POST" && pathname === "/internal/retry") {
        const sub = url.searchParams.get("subdomain");
        const t = sub ? await store.get(sub) : null;
        if (!t) return json(res, 404, { error: "no such tenant" });
        provisioner.provision({
          subdomain: t.subdomain, email: t.email, name: t.displayName,
          subscriptionId: t.dodoSubscriptionId, customerId: t.dodoCustomerId,
          currentPeriodEnd: t.currentPeriodEnd,
        }).catch((e) => console.error(`[retry] ${e.message}`));
        return json(res, 202, { ok: true, retrying: t.subdomain });
      }
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`[server] ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[control-plane] listening on 127.0.0.1:${config.port}`);
  console.log(`[control-plane] webhook URL: https://${config.controlHost}/webhooks/dodo`);
});
