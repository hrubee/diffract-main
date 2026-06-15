# Diffract control plane

Turns a **Dodo payment** into a **fresh Hostinger VPS with Diffract pre-installed**,
reachable at **`<client>.diffraction.in`** — automatically.

```
diffraction.in/signup  ──pick subdomain + pay──▶  Dodo (LIVE, ₹2000/mo)
                                                    │  subscription.active webhook
                                                    ▼
        ┌──────────────  CONTROL VPS (this service + Caddy)  ─────────────┐
        │  verify Standard-Webhooks signature + idempotency               │
        │  → create Hostinger post-install script (install.sh + tenant env)│
        │  → purchaseNewVirtualMachine(itemId, setup{postInstallScriptId}) │
        │  → poll until running → read IP                                  │
        │  → add Caddy route  <sub>.diffraction.in → vpsIp:80             │
        │  → health-check through the ingress → status=active → email URL │
        └────────────────────────────────────────────────────────────────┘
                  client.diffraction.in ──▶ that client's fresh Diffract box
```

The per-client box runs the **existing single-tenant stack** unchanged (`install.sh`
→ `setup.sh --vps`), whose own Caddy on `:80` already routes `/agent → :9119`,
`/v1 → :8642`, else `:3000`. The central ingress just reverse-proxies the whole
host to `vpsIp:80`, so we reuse that verified routing. The box's `:80` is firewalled
(ufw) to accept only the ingress IP.

## Design decisions (locked with the operator)

| Decision | Choice |
|---|---|
| Isolation | **VPS per client** (purchase-on-demand via Hostinger API) |
| VPS provider | **Hostinger** (`purchaseNewVirtualMachineV1` + post-install script) |
| Control plane host | **dedicated control VPS** (keeps the live demo box untouched) |
| Routing / DNS | **wildcard `*.diffraction.in` → central Caddy ingress**, on-demand TLS |
| Inference | **Diffract-injected shared key** at provision (chat works out of the box) |

## What the operator must provide

1. **A dedicated control VPS** (small Ubuntu/Debian box, public IP). Not the live demo box.
2. **One DNS record:** `*.diffraction.in  A  <control-vps-ip>` (apex `diffraction.in` +
   `www` stay on Hostinger shared hosting for the marketing site).
3. **Hostinger API token** (hPanel → API; scope: VPS management + purchase) **and three
   catalog ids** from your account:
   - `HOSTINGER_ITEM_ID` — the VPS plan to buy per client (`GET /api/billing/v1/catalog`).
   - `HOSTINGER_TEMPLATE_ID` — a plain Ubuntu 22.04/24.04 template (`GET /api/vps/v1/templates`).
   - `HOSTINGER_DATACENTER_ID` — a location (`GET /api/vps/v1/data-centers`).
   - A **payment method on file** in Hostinger (purchase charges your billing per client).
4. **Dodo webhook secret** (Dodo dashboard → Webhooks; Standard Webhooks signing secret).
5. **The shared inference key** (`INJECT_INFERENCE_KEY`) + provider/model to inject into
   every client box (e.g. NVIDIA).
6. A long random **`ADMIN_API_TOKEN`** (protects `/internal/*`).

## Deploy (on the control VPS, as root)

```bash
git clone https://github.com/riaan-attar/diffract-main && cd diffract-main/control-plane
sudo bash deploy/setup-control-plane.sh        # installs Node 22 + Caddy, seeds .env, installs systemd unit
sudo nano /opt/diffract-control/.env           # fill in every value under "OPERATOR MUST SET"
sudo nano /etc/caddy/Caddyfile                 # set your ACME email + domain; then: systemctl reload caddy
sudo systemctl start diffract-control
journalctl -u diffract-control -f
```

Then point DNS (`*.diffraction.in → this IP`) and set the **Dodo webhook URL** to:

```
https://cp.diffraction.in/webhooks/dodo
```

## Website side (Hostinger shared hosting)

Already wired in `website/`:
- `signup.html` collects the subdomain **before** checkout (live availability via `api/available.php`).
- `api/checkout.php` carries `workspace` + `email` into the Dodo **metadata** (which the webhook reads)
  and guards against a taken name (fail-open).
- `api/available.php` proxies availability to the control plane (no CORS, control host stays server-side).
- `api/claim.php` is now just an audit trail.

Add **one line** to the website's `.diffract-dodo.env` (one level above `public_html`, next to the Dodo key):

```
CONTROL_PLANE_BASE=https://cp.diffraction.in
```

## Verify

```bash
# control plane up
curl -s https://cp.diffraction.in/healthz                       # {"ok":true}
# availability
curl -s 'https://cp.diffraction.in/api/available?subdomain=acme' # {"available":true,...}
# tenants (ops)
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" https://cp.diffraction.in/internal/tenants
# end-to-end: a real (or Dodo test-mode) subscription.active should appear in the journal as
#   [webhook] subscription.active action=provision sub=acme ...
#   [provision] acme: ordered VPS ... running at ... ingress route ... ACTIVE
```

Local tests (no infra needed): `cd control-plane && node --test`.

## Operational notes / known edges (validate on the box)

- **`config.mjs` fails fast** — the service refuses to boot if any required secret/id is missing,
  so it never half-takes a payment it can't fulfil.
- **Idempotency** — Dodo delivers at-least-once; `webhook-id`s are de-duped in the tenant store.
  A provision that crashes mid-flight leaves the tenant `failed`/`provisioning`; re-run with
  `POST /internal/retry?subdomain=<sub>` (Bearer `ADMIN_API_TOKEN`).
- **Hostinger purchase charges your billing** on every provision. Cancellation only **suspends**
  (removes the route); VPS teardown is left manual on purpose (`deprovision()`), so a paid box is
  never destroyed automatically.
- **Two things to confirm against a live Hostinger account**, since their response JSON drifts:
  the VM id / state / IP field names (`hostinger.mjs` `extractVm*` read several shapes) and that
  `purchaseNewVirtualMachineV1` returns the new VM id synchronously.
- **Auto-deploy of the agent** on the client box (post-install step 4) drives the dashboard's
  `login → GET /api/deploy` route with the injected key. If a box ever lands without a working
  agent, the operator can deploy from that box's dashboard — provisioning still completes.
- **Metadata propagation** — we rely on Dodo carrying checkout `metadata` onto the
  `subscription.active` webhook. If your Dodo plan doesn't, the webhook logs a paid event with no
  subdomain and flags it for manual fulfilment; `claim.php`'s audit log is the correlation source.
- **Email** is best-effort (system `sendmail` + an on-disk `outbox/`). Wire a transactional provider
  in `email.mjs` for delivery guarantees.

## Security posture

- The webhook is signature-verified (constant-time) with a replay window; bodies are never parsed
  before verification.
- The control host only mints TLS certs for live tenants (`/tls/ask` gate) — never arbitrary hosts.
- Client boxes expose only `:80`, only to the ingress IP (ufw).
- **The injected inference key is a shared secret that lives on every client box** (operator's
  accepted tradeoff for out-of-the-box chat). Rotate it by updating `INJECT_INFERENCE_KEY` and
  re-provisioning; treat each client box as holding it.
