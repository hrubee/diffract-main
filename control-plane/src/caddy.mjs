// ─────────────────────────────────────────────────────────────────────────────
// Central Caddy ingress control (via the admin API on 127.0.0.1:2019).
//
// The base Caddyfile (deploy/Caddyfile) sets up automatic + on-demand TLS for
// *.diffraction.in and fronts this control service. Per-tenant routes are added
// here dynamically: a host match for <sub>.diffraction.in that reverse-proxies
// the WHOLE host to the client box's own Caddy on :80 — which already does the
// verified /agent -> :9119, /v1 -> :8642, else -> :3000 internal routing. So the
// ingress stays dumb (host -> vpsIp:80) and we reuse the box's routing untouched.
//
// Each route carries an "@id" of `tenant-<sub>` so it can be deleted on cancel.
// Routes are PREPENDED (PUT at routes/0) so they're evaluated before the base
// Caddyfile's `*.diffraction.in` catch-all (which 404s unknown subdomains).
// ─────────────────────────────────────────────────────────────────────────────

export class CaddyError extends Error {
  constructor(method, url, status, body) {
    super(`Caddy ${method} ${url} -> ${status}: ${body}`);
    this.name = "CaddyError";
    this.status = status;
  }
}

export class Caddy {
  #admin;
  #server;

  constructor({ admin = "http://127.0.0.1:2019", server = "srv0" }) {
    this.#admin = admin.replace(/\/+$/, "");
    this.#server = server;
  }

  async #req(method, path, body) {
    const url = this.#admin + path;
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status !== 404) {
      throw new CaddyError(method, url, res.status, await res.text().catch(() => ""));
    }
    return res;
  }

  static routeId(subdomain) {
    return `tenant-${subdomain}`;
  }

  /** Idempotently (re)point <sub>.<domain> at vpsIp:80. */
  async upsertTenantRoute(subdomain, domain, vpsIp) {
    await this.removeTenantRoute(subdomain); // delete any stale route first
    const route = {
      "@id": Caddy.routeId(subdomain),
      match: [{ host: [`${subdomain}.${domain}`] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${vpsIp}:80` }] }],
      terminal: true,
    };
    // PUT at index 0 INSERTS (prepends) — so the tenant route wins over the
    // wildcard catch-all defined in the base Caddyfile.
    await this.#req("PUT", `/config/apps/http/servers/${this.#server}/routes/0`, route);
  }

  /** Remove a tenant's route (no-op if absent). */
  async removeTenantRoute(subdomain) {
    await this.#req("DELETE", `/id/${Caddy.routeId(subdomain)}`);
  }
}
