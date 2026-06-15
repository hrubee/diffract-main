// ─────────────────────────────────────────────────────────────────────────────
// Dodo Payments webhooks — Standard Webhooks signature verification + parsing.
//
// Dodo signs every webhook per the Standard Webhooks spec
// (https://www.standardwebhooks.com). Three headers ride with the request:
//
//   webhook-id          unique event id  (use for idempotency)
//   webhook-timestamp   unix seconds when sent
//   webhook-signature   space-separated "v1,<base64sig>" tokens
//
// The signed content is the EXACT raw body, prefixed with id + timestamp:
//   signed = `${webhook-id}.${webhook-timestamp}.${rawBody}`
// signature = base64( HMAC_SHA256( secretBytes, signed ) )
// where secretBytes = base64-decode( secret without its "whsec_" prefix ).
//
// We compare in constant time, and reject anything older than the tolerance to
// blunt replay. NEVER parse the body before verifying.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {{ headers: Record<string,string>, rawBody: string, secret: string }} args
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyWebhook({ headers, rawBody, secret }) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing webhook signature headers" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "non-numeric webhook-timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > TOLERANCE_SECONDS) return { ok: false, reason: `timestamp skew ${skew}s exceeds tolerance` };

  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(rawSecret, "base64");
  if (keyBytes.length === 0) return { ok: false, reason: "empty/invalid webhook secret" };

  const signed = `${id}.${ts}.${rawBody}`;
  const expected = crypto.createHmac("sha256", keyBytes).update(signed, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  // The header may carry several signatures (key rotation). Accept if any match.
  const provided = sigHeader.split(/\s+/).map((tok) => (tok.includes(",") ? tok.slice(tok.indexOf(",") + 1) : tok));
  const match = provided.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  return match ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// Event types we act on. Dodo emits dotted names; we normalize then classify.
const PROVISION_EVENTS = new Set(["subscription.active", "payment.succeeded"]);
const DEPROVISION_EVENTS = new Set(["subscription.cancelled", "subscription.canceled", "subscription.expired"]);
const RENEW_EVENTS = new Set(["subscription.renewed"]);

/**
 * Pull the fields we need out of a verified Dodo event body, tolerating the
 * shape drift between payment.* and subscription.* payloads.
 *
 * @param {any} body  parsed JSON of the webhook
 * @returns {{
 *   action: "provision" | "deprovision" | "renew" | "ignore",
 *   type: string,
 *   subdomain: string,
 *   email: string,
 *   name: string,
 *   subscriptionId: string,
 *   customerId: string,
 *   currentPeriodEnd: string,
 * }}
 */
export function parseEvent(body) {
  const type = String(body?.type ?? "").toLowerCase();
  const data = body?.data ?? {};
  // metadata is where checkout.php stashed the chosen workspace/email/name.
  const meta = data.metadata ?? data.payload?.metadata ?? {};
  const customer = data.customer ?? data.payload?.customer ?? {};

  let action = "ignore";
  if (PROVISION_EVENTS.has(type)) action = "provision";
  else if (DEPROVISION_EVENTS.has(type)) action = "deprovision";
  else if (RENEW_EVENTS.has(type)) action = "renew";

  return {
    action,
    type,
    subdomain: String(meta.workspace ?? meta.subdomain ?? "").toLowerCase().trim(),
    email: String(meta.email ?? customer.email ?? data.email ?? "").trim(),
    name: String(meta.name ?? customer.name ?? "").trim(),
    subscriptionId: String(data.subscription_id ?? data.subscriptionId ?? data.id ?? "").trim(),
    customerId: String(customer.customer_id ?? customer.id ?? data.customer_id ?? "").trim(),
    currentPeriodEnd: String(data.current_period_end ?? data.next_billing_date ?? "").trim(),
  };
}
