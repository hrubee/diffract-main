// ─────────────────────────────────────────────────────────────────────────────
// DNS adapter — points <sub>.<domain> straight at a client VPS's public IP.
//
// This REPLACES the old central-Caddy ingress. On Railway the control plane is no
// longer a reverse proxy: each client box terminates its OWN TLS (its install.sh
// runs Caddy with the real hostname → Let's Encrypt), so all we publish is a plain
// A record. No proxy, no on-demand-TLS gate, no ingress IP.
//
// Two backends, chosen by DNS_PROVIDER:
//   "hostinger"  (default) — the domain + the VPSs already live in one Hostinger
//                 account, so we reuse the same API token. No nameserver move.
//   "cloudflare"          — if the zone is on Cloudflare instead.
//
// Both expose the same tiny surface:
//   pointSubdomain(sub, ip)   upsert an A record  <sub>.<domain> -> ip
//   unpointSubdomain(sub)     delete it (cancel/refund)
//
// `fetchImpl` is injectable for tests; defaults to global fetch.
// ─────────────────────────────────────────────────────────────────────────────

export class DnsError extends Error {
  constructor(method, url, status, body) {
    super(`DNS ${method} ${url} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "DnsError";
    this.status = status;
    this.body = body;
  }
}

async function requestJson(fetchImpl, method, url, { token, body } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new DnsError(method, url, res.status, parsed);
  return parsed;
}

// ── Hostinger DNS (developers.hostinger.com /api/dns/v1) ────────────────────────
// Zone is managed by name+type. PUT with overwrite:true replaces just the records
// for that (name, type), leaving the rest of the zone (apex, www, …) untouched.
// Field names follow the Hostinger DNS API — validate against a live zone the
// first time (their response JSON has drifted before; see hostinger.mjs).
export class HostingerDns {
  #fetch; #token; #base; #domain; #ttl;
  constructor({ token, base = "https://developers.hostinger.com", domain, ttl = 300 }, fetchImpl = fetch) {
    if (!token) throw new DnsError("init", "hostinger-dns", 0, "missing HOSTINGER_API_TOKEN (or HOSTINGER_DNS_TOKEN)");
    if (!domain) throw new DnsError("init", "hostinger-dns", 0, "missing CONTROL_DOMAIN");
    this.#fetch = fetchImpl;
    this.#token = token;
    this.#base = base.replace(/\/+$/, "");
    this.#domain = domain;
    this.#ttl = ttl;
  }
  #zoneUrl() { return `${this.#base}/api/dns/v1/zones/${encodeURIComponent(this.#domain)}`; }

  async pointSubdomain(sub, ip) {
    const body = {
      overwrite: true,
      zone: [{ name: sub, type: "A", ttl: this.#ttl, records: [{ content: ip }] }],
    };
    return requestJson(this.#fetch, "PUT", this.#zoneUrl(), { token: this.#token, body });
  }

  async unpointSubdomain(sub) {
    const body = { filters: [{ name: sub, type: "A" }] };
    return requestJson(this.#fetch, "DELETE", this.#zoneUrl(), { token: this.#token, body });
  }
}

// ── Cloudflare DNS (api.cloudflare.com/client/v4) ───────────────────────────────
// proxied:false is REQUIRED — we want DNS only, so TLS terminates on the client
// box (Cloudflare's orange-cloud proxy would otherwise intercept it).
export class CloudflareDns {
  #fetch; #token; #zoneId; #base; #domain; #ttl;
  constructor({ token, zoneId, base = "https://api.cloudflare.com/client/v4", domain, ttl = 300 }, fetchImpl = fetch) {
    if (!token) throw new DnsError("init", "cloudflare-dns", 0, "missing CLOUDFLARE_API_TOKEN");
    if (!zoneId) throw new DnsError("init", "cloudflare-dns", 0, "missing CLOUDFLARE_ZONE_ID");
    if (!domain) throw new DnsError("init", "cloudflare-dns", 0, "missing CONTROL_DOMAIN");
    this.#fetch = fetchImpl;
    this.#token = token;
    this.#zoneId = zoneId;
    this.#base = base.replace(/\/+$/, "");
    this.#domain = domain;
    this.#ttl = ttl;
  }
  #fqdn(sub) { return `${sub}.${this.#domain}`; }
  #recordsUrl() { return `${this.#base}/zones/${this.#zoneId}/dns_records`; }

  async #findId(fqdn) {
    const url = `${this.#recordsUrl()}?type=A&name=${encodeURIComponent(fqdn)}`;
    const out = await requestJson(this.#fetch, "GET", url, { token: this.#token });
    return out?.result?.[0]?.id ?? null;
  }

  async pointSubdomain(sub, ip) {
    const fqdn = this.#fqdn(sub);
    const body = { type: "A", name: fqdn, content: ip, ttl: this.#ttl, proxied: false };
    const id = await this.#findId(fqdn);
    return id
      ? requestJson(this.#fetch, "PUT", `${this.#recordsUrl()}/${id}`, { token: this.#token, body })
      : requestJson(this.#fetch, "POST", this.#recordsUrl(), { token: this.#token, body });
  }

  async unpointSubdomain(sub) {
    const id = await this.#findId(this.#fqdn(sub));
    if (!id) return null; // already gone
    return requestJson(this.#fetch, "DELETE", `${this.#recordsUrl()}/${id}`, { token: this.#token });
  }
}

/**
 * Build the configured DNS backend. Throws at startup (fail-fast) if the selected
 * provider is missing its credentials, so we never take a payment we can't route.
 * @param {{ provider:string, domain:string, ttl:number,
 *           hostinger:{token:string,base:string},
 *           cloudflare:{token:string,zoneId:string,base:string} }} cfg
 */
export function createDns(cfg, { fetchImpl = fetch } = {}) {
  const provider = String(cfg.provider || "hostinger").toLowerCase();
  if (provider === "hostinger") {
    return new HostingerDns({ ...cfg.hostinger, domain: cfg.domain, ttl: cfg.ttl }, fetchImpl);
  }
  if (provider === "cloudflare") {
    return new CloudflareDns({ ...cfg.cloudflare, domain: cfg.domain, ttl: cfg.ttl }, fetchImpl);
  }
  throw new DnsError("init", "createDns", 0, `unknown DNS_PROVIDER "${provider}" (use hostinger | cloudflare)`);
}
