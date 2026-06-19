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
// SAFETY: these run against a SHARED, live zone (diffraction.in also hosts
// app.diffraction.in, www, MX, …). Every write is non-destructive by design:
//   • a hard guard refuses to touch protected names (app/@/www/mail/…),
//   • Hostinger writes are read-merge-PUT — we echo back the existing zone and only
//     add/replace the one tenant A record, so a sibling like app can never be
//     dropped regardless of how the API interprets `overwrite`,
//   • if the zone can't be read first, we ABORT rather than risk a partial PUT.
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

// Names the adapter will NEVER create, replace, or delete — apex + the live
// service records on diffraction.in. Tenant subdomains are validated separately
// (config.isValidSubdomain) and can never be one of these, so this is defence in
// depth: even a bug upstream cannot make us write `app`.
const PROTECTED_NAMES = new Set([
  "@", "", "app", "www", "api", "admin", "root", "mail", "ftp", "cdn",
  "ns", "ns1", "ns2", "mx", "smtp", "webmail", "cp", "control",
]);

function assertSafeName(sub) {
  const n = String(sub ?? "").toLowerCase().trim();
  if (!n || PROTECTED_NAMES.has(n)) {
    throw new DnsError("guard", n || "(empty)", 0, `refusing to touch protected/empty DNS name "${n}"`);
  }
  return n;
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
// Writes are serialized (in-process mutex) + read-merge-PUT, so concurrent
// provisions can't race-drop each other's records and a sibling like app is never
// at risk. Field names follow the Hostinger DNS API — confirm against a live zone
// with a THROWAWAY name (never app); see README "known edges".
export class HostingerDns {
  #fetch; #token; #base; #domain; #ttl; #chain = Promise.resolve();
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

  // Serialize every mutation: read-merge-PUT must be atomic per instance.
  async #withLock(fn) {
    const prev = this.#chain;
    let release;
    this.#chain = new Promise((r) => (release = r));
    try { await prev; } catch { /* prior op's failure must not block the next */ }
    try { return await fn(); } finally { release(); }
  }

  async #getZoneRecords() {
    const out = await requestJson(this.#fetch, "GET", this.#zoneUrl(), { token: this.#token });
    if (Array.isArray(out)) return out;
    if (Array.isArray(out?.zone)) return out.zone;
    if (Array.isArray(out?.records)) return out.records;
    if (Array.isArray(out?.data)) return out.data;
    return null; // unknown shape -> caller fails safe
  }

  async pointSubdomain(sub, ip) {
    const name = assertSafeName(sub);
    return this.#withLock(async () => {
      const existing = await this.#getZoneRecords();
      // Fail SAFE: never PUT a zone we couldn't read in full. A false-empty read
      // would otherwise let a zone-wide `overwrite` wipe siblings (e.g. app).
      if (!existing || existing.length === 0) {
        throw new DnsError("GET", this.#zoneUrl(), 0, "refusing to write: could not read existing zone records");
      }
      // Echo back every other record untouched; replace only this tenant's A record.
      const others = existing.filter(
        (r) => !(String(r?.name).toLowerCase() === name && String(r?.type).toUpperCase() === "A"),
      );
      const zone = [...others, { name, type: "A", ttl: this.#ttl, records: [{ content: ip }] }];
      return requestJson(this.#fetch, "PUT", this.#zoneUrl(), { token: this.#token, body: { overwrite: true, zone } });
    });
  }

  async unpointSubdomain(sub) {
    const name = assertSafeName(sub);
    // DELETE-by-filter is inherently record-scoped (name+type), so it cannot affect
    // any other record — safe without a full read-merge.
    return this.#withLock(() =>
      requestJson(this.#fetch, "DELETE", this.#zoneUrl(), { token: this.#token, body: { filters: [{ name, type: "A" }] } }),
    );
  }
}

// ── Cloudflare DNS (api.cloudflare.com/client/v4) ───────────────────────────────
// Inherently per-record (operates on a single record id), so it can never touch a
// sibling. proxied:false is REQUIRED — DNS only, so TLS terminates on the box.
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
    const name = assertSafeName(sub);
    const fqdn = this.#fqdn(name);
    const body = { type: "A", name: fqdn, content: ip, ttl: this.#ttl, proxied: false };
    const id = await this.#findId(fqdn);
    return id
      ? requestJson(this.#fetch, "PUT", `${this.#recordsUrl()}/${id}`, { token: this.#token, body })
      : requestJson(this.#fetch, "POST", this.#recordsUrl(), { token: this.#token, body });
  }

  async unpointSubdomain(sub) {
    const name = assertSafeName(sub);
    const id = await this.#findId(this.#fqdn(name));
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
