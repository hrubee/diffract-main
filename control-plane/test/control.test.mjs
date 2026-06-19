// Run: node --test  (from control-plane/)
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook, parseEvent } from "../src/dodo.mjs";
import { buildPostInstallScript } from "../src/postinstall.mjs";
import { createDns, HostingerDns, CloudflareDns, DnsError } from "../src/dns.mjs";

// Helper: sign a body the way Dodo (Standard Webhooks) does.
function sign({ id, ts, body, secret }) {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(raw, "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

const SECRET = "whsec_" + Buffer.from("super-secret-signing-key-1234567890").toString("base64");

test("valid signature verifies", () => {
  const id = "evt_1", ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "subscription.active" });
  const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign({ id, ts, body, secret: SECRET }) };
  assert.equal(verifyWebhook({ headers, rawBody: body, secret: SECRET }).ok, true);
});

test("tampered body is rejected", () => {
  const id = "evt_2", ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "subscription.active" });
  const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign({ id, ts, body, secret: SECRET }) };
  const res = verifyWebhook({ headers, rawBody: body + "x", secret: SECRET });
  assert.equal(res.ok, false);
});

test("stale timestamp is rejected (replay guard)", () => {
  const id = "evt_3", ts = String(Math.floor(Date.now() / 1000) - 3600);
  const body = "{}";
  const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign({ id, ts, body, secret: SECRET }) };
  const res = verifyWebhook({ headers, rawBody: body, secret: SECRET });
  assert.equal(res.ok, false);
  assert.match(res.reason, /skew/);
});

test("wrong secret is rejected", () => {
  const id = "evt_4", ts = String(Math.floor(Date.now() / 1000));
  const body = "{}";
  const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign({ id, ts, body, secret: SECRET }) };
  const other = "whsec_" + Buffer.from("different-key").toString("base64");
  assert.equal(verifyWebhook({ headers, rawBody: body, secret: other }).ok, false);
});

test("missing headers rejected", () => {
  assert.equal(verifyWebhook({ headers: {}, rawBody: "{}", secret: SECRET }).ok, false);
});

test("parseEvent classifies + extracts subdomain/email from metadata", () => {
  const ev = parseEvent({
    type: "subscription.active",
    data: {
      subscription_id: "sub_123",
      current_period_end: "2026-07-15",
      customer: { customer_id: "cus_9", email: "fallback@x.com" },
      metadata: { workspace: "acme", email: "owner@acme.com", name: "Acme Inc" },
    },
  });
  assert.equal(ev.action, "provision");
  assert.equal(ev.subdomain, "acme");
  assert.equal(ev.email, "owner@acme.com");
  assert.equal(ev.subscriptionId, "sub_123");
  assert.equal(ev.customerId, "cus_9");
});

test("parseEvent maps cancellation to deprovision", () => {
  assert.equal(parseEvent({ type: "subscription.cancelled", data: { subscription_id: "s" } }).action, "deprovision");
});

test("post-install script is valid-shape bash, under 48KB, with injected values", () => {
  const script = buildPostInstallScript({
    subdomain: "acme",
    adminPassword: "p@ss'word",   // includes a quote to test escaping
    domain: "diffraction.in",
    install: { installUrl: "https://x/install.sh", repo: "https://github.com/a/b", branch: "main", githubToken: "" },
    inject: { provider: "nvidia", key: "nv-secret-key", model: "nvidia/nemotron-3-super-120b-a12b" },
  });
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
  assert.ok(Buffer.byteLength(script, "utf8") < 48 * 1024);
  assert.match(script, /NVIDIA_API_KEY=nv-secret-key/);
  // box runs its OWN HTTPS at its real hostname (no central ingress)
  assert.match(script, /export DIFFRACT_DOMAIN='acme\.diffraction\.in'/);
  assert.match(script, /ufw allow 80\/tcp/);
  assert.match(script, /ufw allow 443\/tcp/);
  // the admin password's single quote must be safely escaped
  assert.match(script, /p@ss'\\''word/);
});

// ── DNS adapter ────────────────────────────────────────────────────────────────
// A fetch stub that records the last request and returns an ok JSON response.
function stubFetch(responseBody = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(responseBody) };
  };
  return { impl, calls };
}

test("Hostinger DNS upsert PUTs an A record for the subdomain to the zone", async () => {
  const { impl, calls } = stubFetch({ ok: true });
  const dns = new HostingerDns({ token: "ht", domain: "diffraction.in", ttl: 300 }, impl);
  await dns.pointSubdomain("acme", "203.0.113.9");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/api\/dns\/v1\/zones\/diffraction\.in$/);
  assert.equal(calls[0].headers.Authorization, "Bearer ht");
  assert.equal(calls[0].body.overwrite, true);
  assert.deepEqual(calls[0].body.zone[0], { name: "acme", type: "A", ttl: 300, records: [{ content: "203.0.113.9" }] });
});

test("Hostinger DNS unpoint DELETEs by name+type filter", async () => {
  const { impl, calls } = stubFetch();
  const dns = new HostingerDns({ token: "ht", domain: "diffraction.in" }, impl);
  await dns.unpointSubdomain("acme");
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(calls[0].body, { filters: [{ name: "acme", type: "A" }] });
});

test("Cloudflare DNS creates an unproxied A record when none exists", async () => {
  // first call (GET lookup) returns empty result -> create path (POST)
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const isLookup = (opts.method ?? "GET") === "GET";
    return { ok: true, status: 200, text: async () => JSON.stringify(isLookup ? { result: [] } : { result: { id: "new" } }) };
  };
  const dns = new CloudflareDns({ token: "cf", zoneId: "zone1", domain: "diffraction.in", ttl: 300 }, impl);
  await dns.pointSubdomain("acme", "203.0.113.9");
  assert.equal(calls.length, 2);                 // lookup + create
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.proxied, false);    // TLS must terminate on the box
  assert.equal(calls[1].body.name, "acme.diffraction.in");
  assert.equal(calls[1].body.content, "203.0.113.9");
});

test("createDns fails fast on unknown provider and missing creds", () => {
  assert.throws(() => createDns({ provider: "route53", domain: "x", ttl: 300, hostinger: {}, cloudflare: {} }), DnsError);
  assert.throws(() => createDns({ provider: "cloudflare", domain: "x", ttl: 300, hostinger: {}, cloudflare: {} }), DnsError);
  // hostinger with a token is fine
  assert.ok(createDns({ provider: "hostinger", domain: "x", ttl: 300, hostinger: { token: "t" }, cloudflare: {} }));
});
