// ─────────────────────────────────────────────────────────────────────────────
// Control-plane HTTP server (Railway — the public pre-payment brain).
//
// Serves the signup/checkout page AND the provisioning glue in one service:
//   GET  /                     signup page (pick subdomain → pay)  [static]
//   POST /api/checkout         create a Dodo hosted-checkout session (workspace
//                              + email ride in metadata for the webhook)
//   GET  /api/available        subdomain availability (live, for the signup page)
//   POST /api/claim            best-effort post-pay audit line (provisioning is
//                              driven by the webhook; this is reconciliation only)
//   POST /webhooks/dodo        verify Standard-Webhooks sig + idempotency, then
//                              provision/deprovision in the background, ACK fast
//   GET  /healthz              liveness (Railway health check)
//   GET  /internal/tenants     ops list (Bearer ADMIN_API_TOKEN)
//   POST /internal/retry       re-run provisioning for a subdomain (Bearer)
//
// Binds 0.0.0.0 (Railway fronts TLS). Each provisioned client box terminates its
// OWN TLS at <client>.diffraction.in, so this service is no longer an ingress.
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, isValidSubdomain } from "./config.mjs";
import { TenantStore } from "./tenants.mjs";
import { Hostinger } from "./hostinger.mjs";
import { createDns } from "./dns.mjs";
import { Provisioner } from "./provisioner.mjs";
import { verifyWebhook, parseEvent } from "./dodo.mjs";
import { sendWelcome } from "./email.mjs";

const MAX_BODY = 1_000_000; // 1 MB cap on bodies

const store = new TenantStore(config.tenantStore);
const hostinger = new Hostinger({ token: config.hostinger.token, base: config.hostinger.base });
const dns = createDns(config.dns); // validates creds → fail fast at boot
const storeDir = path.dirname(path.resolve(config.tenantStore));
const outboxDir = path.join(storeDir, "outbox");
const emailFn = (to, { subdomain, url, adminPassword }) =>
  sendWelcome(config.email, { to, subdomain, url, adminPassword, outboxDir });

const provisioner = new Provisioner({ config, store, hostinger, dns, email: emailFn });

// ── helpers ──────────────────────────────────────────────────────────────────
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function bearerOk(req) {
  return (req.headers.authorization ?? "") === `Bearer ${config.adminApiToken}`;
}

// Slug + email validation mirror the signup page + the provisioner. isValidSubdomain
// (config.mjs) enforces the 3–30 char shape + the reserved list.
function slugify(v) {
  return String(v ?? "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? "")); }

// ── static site (the signup/checkout page) ─────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const STATIC_ROOT = path.resolve(config.webRoot);
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = path.normalize(path.join(STATIC_ROOT, rel));
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + path.sep)) {
    return json(res, 403, { error: "forbidden" }); // path traversal guard
  }
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

// ── route handlers ─────────────────────────────────────────────────────────────
async function handleCheckout(req, res) {
  const raw = await readBody(req);
  let data;
  try { data = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid JSON body" }, corsHeaders()); }
  if (!data || typeof data !== "object") return json(res, 400, { error: "invalid JSON body" }, corsHeaders());

  // Name-before-pay: the workspace + email ride into Dodo metadata, which the
  // webhook reads to provision <workspace>.diffraction.in automatically. Both are
  // tolerated-if-empty so a paid event with no workspace is flagged, never lost.
  const workspace = slugify(data.workspace);
  const email = String(data.email ?? "").trim();
  const name = String(data.name ?? "").trim();

  if (workspace && !isValidSubdomain(workspace)) return json(res, 400, { error: "invalid or reserved workspace name" }, corsHeaders());
  if (workspace) {
    const ex = await store.get(workspace);
    if (ex && ex.status !== "deprovisioned") return json(res, 409, { error: "that workspace name is already taken — pick another" }, corsHeaders());
  }
  if (email && !validEmail(email)) return json(res, 400, { error: "invalid email" }, corsHeaders());
  if (!config.dodo.apiKey) return json(res, 500, { error: "payment backend not configured (DODO_API_KEY)" }, corsHeaders());
  if (!config.dodo.productId) return json(res, 500, { error: "payment backend not configured (DODO_PRODUCT_ID)" }, corsHeaders());

  const returnUrl = `${config.publicBaseUrl}/signup.html?paid=1` + (workspace ? `&ws=${encodeURIComponent(workspace)}` : "");
  const metadata = {};
  if (workspace) metadata.workspace = workspace;
  if (email) metadata.email = email;
  if (name) metadata.name = name;

  const payload = { product_cart: [{ product_id: config.dodo.productId, quantity: 1 }], return_url: returnUrl, metadata };

  let dodoRes, body;
  try {
    dodoRes = await fetch(`${config.dodo.base.replace(/\/+$/, "")}/checkouts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.dodo.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25_000),
    });
    body = await dodoRes.json().catch(() => ({}));
  } catch (e) {
    return json(res, 502, { error: "request to Dodo failed", detail: e.message }, corsHeaders());
  }
  const url = body?.checkout_url ?? body?.url ?? null;
  if (!url) return json(res, 502, { error: "no checkout_url from Dodo", status: dodoRes.status }, corsHeaders());
  return json(res, 200, { url, workspace }, corsHeaders());
}

async function handleAvailable(res, url) {
  const sub = slugify(url.searchParams.get("subdomain"));
  const headers = corsHeaders();
  if (!isValidSubdomain(sub)) return json(res, 200, { available: false, reason: "invalid or reserved name" }, headers);
  const existing = await store.get(sub);
  const taken = existing && existing.status !== "deprovisioned";
  return json(res, 200, { available: !taken, reason: taken ? "already taken" : "" }, headers);
}

async function handleClaim(req, res) {
  // Best-effort reconciliation trail; the webhook is the source of truth. Never
  // fails the request — a missing audit line must not look like a failed signup.
  const raw = await readBody(req).catch(() => "");
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch { /* ignore */ }
  const rec = {
    ts: new Date().toISOString(),
    workspace: slugify(data.workspace),
    email: String(data.email ?? "").trim().slice(0, 200),
    ref: String(data.ref ?? "").slice(0, 2000),
    ip: req.socket?.remoteAddress ?? "",
  };
  try { fs.appendFileSync(path.join(storeDir, "signups.log"), JSON.stringify(rec) + "\n"); } catch { /* best-effort */ }
  return json(res, 200, { ok: true }, corsHeaders());
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

  if (ev.action === "provision") {
    if (!isValidSubdomain(ev.subdomain)) {
      console.error(`[webhook] paid event with invalid/missing subdomain: "${ev.subdomain}" — needs manual fulfilment`);
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

// ── server ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;

    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "POST" && pathname === "/webhooks/dodo") return await handleWebhook(req, res);
    if (req.method === "GET" && pathname === "/api/available") return await handleAvailable(res, url);
    if (req.method === "POST" && pathname === "/api/checkout") return await handleCheckout(req, res);
    if (req.method === "POST" && pathname === "/api/claim") return await handleClaim(req, res);

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
      return json(res, 404, { error: "not found" });
    }

    // Everything else: serve the static signup site.
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(res, pathname);
    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`[server] ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

server.listen(config.port, config.bindHost, () => {
  console.log(`[control-plane] listening on ${config.bindHost}:${config.port}`);
  console.log(`[control-plane] DNS provider: ${config.dns.provider} | domain: ${config.controlDomain}`);
  console.log(`[control-plane] webhook URL: ${config.publicBaseUrl}/webhooks/dodo`);
});
