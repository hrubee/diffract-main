// Run: node --test  (from control-plane/)
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook, parseEvent } from "../src/dodo.mjs";
import { buildPostInstallScript } from "../src/postinstall.mjs";

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
    ingressIp: "203.0.113.7",
    install: { installUrl: "https://x/install.sh", repo: "https://github.com/a/b", branch: "main", githubToken: "" },
    inject: { provider: "nvidia", key: "nv-secret-key", model: "nvidia/nemotron-3-super-120b-a12b" },
  });
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
  assert.ok(Buffer.byteLength(script, "utf8") < 48 * 1024);
  assert.match(script, /NVIDIA_API_KEY=nv-secret-key/);
  assert.match(script, /203\.0\.113\.7/);
  assert.match(script, /ufw allow from "\$INGRESS_IP" to any port 80/);
  // the admin password's single quote must be safely escaped
  assert.match(script, /p@ss'\\''word/);
});
