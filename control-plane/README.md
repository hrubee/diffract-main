# Diffract control plane

The central, pre-payment brain. Hosted on **Railway**, it serves the signup page,
takes the **Dodo payment**, and on success provisions a **fresh Hostinger VPS with
Diffract pre-installed**, reachable at **`<client>.diffraction.in`** — automatically.

```
 Railway (this service)                              one per paying customer
 ┌───────────────────────────────────────┐          ┌────────────────────────┐
 │  GET /          signup + checkout page │          │  Hostinger VPS          │
 │  POST /api/checkout  → Dodo session    │          │  full Diffract stack    │
 │  POST /webhooks/dodo (verified)        │  buy +   │  + dashboard            │
 │     → buy Hostinger VPS (post-install) │  point   │  its OWN HTTPS (Caddy + │
 │     → poll until running, read IP      │ ───────▶ │  Let's Encrypt) at      │
 │     → DNS A <sub>.diffraction.in → IP  │          │  <client>.diffraction.in│
 │     → health-check → email the URL     │          │  inference key injected │
 └───────────────────────────────────────┘          └────────────────────────┘
              │ tenant store on a Railway Volume (/data)
```

The per-client box runs the **existing single-tenant stack** unchanged (`install.sh`
→ `setup.sh <hostname>`), and **terminates its own TLS** — so the control plane is
NOT a reverse proxy. All it publishes is a DNS A record; it never sees client
traffic.

## Design decisions (locked with the operator)

| Decision | Choice |
|---|---|
| Pre-payment surface | **Railway** (this Node service: signup page + checkout + webhook + provisioner) |
| Isolation | **VPS per client** — purchased on demand via the Hostinger API |
| VPS provider | **Hostinger** (`purchaseNewVirtualMachineV1` + post-install script) |
| Routing / DNS | **DNS A record per client** via the Hostinger DNS API (default; Cloudflare optional). Each box does its own HTTPS — no central ingress. |
| Inference | **Diffract-injected shared key** at provision (chat works out of the box) |

## What the operator must provide

1. **A Railway project** with one service pointed at this repo (root dir `control-plane/`)
   and a **Volume mounted at `/data`** (the tenant registry lives there).
2. **Custom domain** on the Railway service for the control host (e.g. `cp.diffraction.in`),
   and the **Dodo webhook** pointed at `https://cp.diffraction.in/webhooks/dodo`.
3. **Hostinger API token** (hPanel → API; scopes: VPS management + purchase **+ DNS**)
   and three catalog ids: `HOSTINGER_ITEM_ID`, `HOSTINGER_TEMPLATE_ID` (plain Ubuntu),
   `HOSTINGER_DATACENTER_ID`. Plus a **payment method on file** (purchase charges your billing).
4. **Dodo**: the webhook **signing secret**, an **API key** (for `/api/checkout`), and the
   subscription **product id** (`DODO_PRODUCT_ID`).
5. **The shared inference key** (`INJECT_INFERENCE_KEY`) + provider/model to inject into
   every client box (e.g. NVIDIA).
6. A long random **`ADMIN_API_TOKEN`** (protects `/internal/*`).

DNS stays on Hostinger by default (one token, no nameserver move). To use Cloudflare
instead, set `DNS_PROVIDER=cloudflare` + `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`.

## Deploy on Railway

1. **New project → Deploy from GitHub repo** (`hrubee/diffract-main`). In the service
   settings set **Root Directory = `control-plane`** (it has a `Dockerfile` + `railway.json`).
2. **Add a Volume**, mount path **`/data`**.
3. **Variables**: paste everything from `.env.example` below the "OPERATOR MUST SET" line
   (leave `PORT` unset — Railway injects it). `TENANT_STORE` already defaults to `/data/tenants.json`.
4. **Settings → Networking → Custom Domain**: add `cp.diffraction.in` (and your apex if you
   want the signup page there too); point the CNAME Railway shows you.
5. **Dodo dashboard → Webhooks**: set the URL to `https://cp.diffraction.in/webhooks/dodo`.
6. Deploy. Railway health-checks `/healthz`.

Local run: `cd control-plane && node --env-file=.env src/server.mjs`. Tests (no infra):
`node --test`.

## DNS / reachability — how a client becomes live

On `payment.succeeded` / `subscription.active`, the provisioner buys the VPS with a
post-install script that runs `install.sh` with `DIFFRACT_DOMAIN=<sub>.diffraction.in`.
The box's own Caddy then requests a Let's Encrypt cert for that hostname. As soon as the
VM reports an IP, the control plane publishes the matching A record. The box's ACME
retries until DNS resolves, so the two race harmlessly to completion. The box opens only
`22/80/443` (ufw). Cancel/refund → drop the DNS record + suspend (VPS teardown stays manual).

## Verify

```bash
curl -s https://cp.diffraction.in/healthz                       # {"ok":true}
curl -s 'https://cp.diffraction.in/api/available?subdomain=acme' # {"available":true,...}
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" https://cp.diffraction.in/internal/tenants
# end-to-end: a real (or Dodo test-mode) subscription.active should log:
#   [webhook] subscription.active action=provision sub=acme ...
#   [provision] acme: ordered VPS ... running at ... DNS A acme.diffraction.in -> ... ACTIVE
```

## Operational notes / known edges (validate on a live account)

- **Fail-fast config** — missing secret/id ⇒ the service refuses to boot, so it never
  half-takes a payment it can't fulfil. The DNS adapter validates its creds at boot too.
- **Idempotency** — Dodo delivers at-least-once; `webhook-id`s are de-duped in the store.
  A crashed provision leaves the tenant `failed`/`provisioning`; re-run with
  `POST /internal/retry?subdomain=<sub>` (Bearer `ADMIN_API_TOKEN`).
- **Hostinger purchase charges your billing** on every provision. Cancellation only drops
  the DNS record + suspends; VPS teardown is left manual on purpose (`deprovision()`).
- **Confirm against a live Hostinger account** (response JSON drifts): the VM id/state/IP
  field names (`hostinger.mjs` `extractVm*`) and the **DNS zone API** request shape
  (`dns.mjs` `HostingerDns` — PUT `…/api/dns/v1/zones/<domain>` with `overwrite:true`).
- **ACME timing** — the box may attempt its cert before the A record propagates; Caddy
  retries automatically. The 8-minute health-check window usually absorbs this.
- **Metadata propagation** — we rely on Dodo carrying checkout `metadata` onto the
  `subscription.active` webhook. If it doesn't, the webhook logs a paid event with no
  subdomain and flags it for manual fulfilment.
- **Email** is best-effort (system `sendmail` + an on-disk `/data/outbox/`). Wire a
  transactional provider in `email.mjs` for delivery guarantees.

## Security posture

- The webhook is signature-verified (constant-time) with a replay window; the body is
  never parsed before verification.
- `/internal/*` requires the bearer `ADMIN_API_TOKEN`. The static site + availability are
  the only unauthenticated surfaces.
- Client boxes expose only `22/80/443`; the control plane never proxies their traffic.
- **The injected inference key is a shared secret that lives on every client box**
  (operator's accepted tradeoff for out-of-the-box chat). Rotate it by updating
  `INJECT_INFERENCE_KEY` and re-provisioning.
