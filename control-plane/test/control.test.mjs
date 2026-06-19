// Run: node --test  (from control-plane/)
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { rmSync } from "node:fs";
import { verifyWebhook, parseEvent } from "../src/dodo.mjs";
import { buildPostInstallScript } from "../src/postinstall.mjs";
import { createDns, HostingerDns, CloudflareDns, DnsError } from "../src/dns.mjs";
import { parseSmtpUrl, addrOnly, dotStuff } from "../src/email.mjs";
import { TenantStore } from "../src/tenants.mjs";

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

test("Hostinger DNS point PRESERVES existing records (app) and adds the tenant", async () => {
  // The live zone already has app.diffraction.in + MX. Provisioning `acme` must
  // read the zone (GET) then PUT it back with app intact + acme added. This test
  // encodes the operator's hard constraint: do not touch app.diffraction.in.
  const existingZone = [
    { name: "app", type: "A", ttl: 14400, records: [{ content: "187.127.132.39" }] },
    { name: "@", type: "MX", ttl: 14400, records: [{ content: "10 mx.diffraction.in" }] },
  ];
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(method === "GET" ? existingZone : { ok: true }) };
  };
  const dns = new HostingerDns({ token: "ht", domain: "diffraction.in", ttl: 300 }, impl);
  await dns.pointSubdomain("acme", "203.0.113.9");
  assert.equal(calls[0].method, "GET");                 // reads first
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].body.overwrite, true);
  const byName = Object.fromEntries(calls[1].body.zone.map((r) => [r.name, r]));
  assert.ok(byName.app, "app.diffraction.in MUST be preserved in the PUT");
  assert.deepEqual(byName.app.records, [{ content: "187.127.132.39" }]);
  assert.ok(byName["@"], "the MX record must be preserved too");
  assert.deepEqual(byName.acme, { name: "acme", type: "A", ttl: 300, records: [{ content: "203.0.113.9" }] });
});

test("Hostinger DNS point FAILS SAFE when the zone can't be read (won't wipe siblings)", async () => {
  const impl = async () => ({ ok: true, status: 200, text: async () => "[]" }); // false-empty read
  const dns = new HostingerDns({ token: "ht", domain: "diffraction.in" }, impl);
  await assert.rejects(() => dns.pointSubdomain("acme", "1.2.3.4"), /could not read existing zone/);
});

test("DNS adapters REFUSE to touch protected names (app / www)", async () => {
  const impl = async () => ({ ok: true, status: 200, text: async () => "[]" });
  const h = new HostingerDns({ token: "ht", domain: "diffraction.in" }, impl);
  await assert.rejects(() => h.pointSubdomain("app", "1.2.3.4"), /protected/);
  await assert.rejects(() => h.unpointSubdomain("app"), /protected/);
  const cf = new CloudflareDns({ token: "cf", zoneId: "z", domain: "diffraction.in" }, impl);
  await assert.rejects(() => cf.pointSubdomain("www", "1.2.3.4"), /protected/);
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

// ── email (SMTP helpers) ────────────────────────────────────────────────────────
test("parseSmtpUrl parses a Hostinger smtps URL and decodes the password", () => {
  const s = parseSmtpUrl("smtps://you%40diffraction.in:p%40ss%3Aword@smtp.hostinger.com:465");
  assert.equal(s.secure, true);
  assert.equal(s.host, "smtp.hostinger.com");
  assert.equal(s.port, 465);
  assert.equal(s.user, "you@diffraction.in");
  assert.equal(s.pass, "p@ss:word");
  assert.equal(parseSmtpUrl(""), null);
  assert.equal(parseSmtpUrl("http://nope"), null);
});

test("addrOnly + dotStuff", () => {
  assert.equal(addrOnly("Diffract <noreply@diffraction.in>"), "noreply@diffraction.in");
  assert.equal(addrOnly("bare@x.com"), "bare@x.com");
  assert.equal(dotStuff("line1\r\n.hidden\r\n"), "line1\r\n..hidden\r\n");
  assert.equal(dotStuff(".start"), "..start");
});

// ── tenant recovery (restart resilience) ──────────────────────────────────────────
test("recoverInterrupted flips stale provisioning -> failed; leaves active alone", async () => {
  const file = path.join(os.tmpdir(), `cp-test-tenants-${process.pid}.json`);
  rmSync(file, { force: true });
  const store = new TenantStore(file);
  await store.upsert("stuck", { status: "provisioning", email: "a@b.com" });
  await store.upsert("live", { status: "active", email: "c@d.com" });
  const recovered = await store.recoverInterrupted();
  assert.deepEqual(recovered, ["stuck"]);
  assert.equal((await store.get("stuck")).status, "failed");
  assert.match((await store.get("stuck")).error, /interrupted/);
  assert.equal((await store.get("live")).status, "active"); // untouched
  rmSync(file, { force: true });
});
