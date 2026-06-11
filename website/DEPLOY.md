# Deploying the website to diffraction.in (Hostinger shared hosting)

The site is uploaded by hand via **hPanel → File Manager**. There is no file-deploy
API on Hostinger shared hosting (only VPS + DNS APIs), so this is a manual upload.

Server account: `u878019455` · web root: `/home/u878019455/domains/diffraction.in/public_html`

---

## 1. Upload these into `public_html/`

| File | Purpose |
|------|---------|
| `index.html`        | Landing page → becomes `diffraction.in`. Static, no backend. |
| `diffract.tar.gz`   | Product release. `install.sh` downloads it from `https://diffraction.in/diffract.tar.gz` — **must sit at public_html root.** (~21 MB; verified current + no bundled secrets.) |
| `install.sh`        | Installer mirror. |
| `signup.html`       | Workspace + email → Dodo checkout. Reachable by direct URL; not linked from the landing page. |
| `.htaccess`         | Denies any `.env` from being served; adds a `/api/checkout` pretty-URL rewrite. |
| `api/checkout.php`  | Payment backend (PHP — runs natively on LiteSpeed). Create an `api/` folder and put it inside. |

**Do NOT upload** (dev-only): `local-dev-server.py`, `package.json`, `package-lock.json`,
`.gitignore`, `.gitattributes`, `DEPLOY.md`, `.mulch/`, or any `*.example` file.

> File Manager won't show dotfiles by default — toggle **Settings → Show hidden files**
> (dotfiles) so you can see/upload `.htaccess`.

## 2. Place the live payment secret ABOVE public_html (one level up)

Create a file named **`.diffract-dodo.env`** at:

```
/home/u878019455/domains/diffraction.in/.diffract-dodo.env
```

with a single line (template in `.diffract-dodo.env.example`):

```
DODO_PAYMENTS_API_KEY=<the live Dodo key>
```

This is **outside** `public_html`, so it is never web-accessible. `api/checkout.php`
reads it from there. **Never** put the key inside a tracked file or inside `public_html`.

In File Manager: navigate up out of `public_html` to the `diffraction.in` folder,
**New File** → `.diffract-dodo.env` → Edit → paste the line → Save.

## 3. Smoke-test (this does NOT charge anyone)

Creating a checkout *session* is free; a charge only happens if someone actually pays
on Dodo's hosted page. Run:

```bash
curl -sS -X POST https://diffraction.in/api/checkout.php \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"testco","email":"you@example.com"}'
```

- ✅ Expect: `{"url":"https://live.dodopayments.com/...","workspace":"testco"}`
- ❌ `{"error":"payment backend not configured ..."}` → the `.diffract-dodo.env` path or
  permissions are wrong (step 2).
- ❌ `{"error":"request to Dodo failed", ...}` → Hostinger is blocking outbound HTTPS from
  PHP. If so, the checkout backend must move to a VPS instead of shared hosting.

Then open `https://diffraction.in/` (landing) and `https://diffraction.in/signup.html`
(submit the form → should redirect to the Dodo checkout page).

---

## ⚠️ Before you take real money

Payments use the **LIVE** Dodo key — real ₹2,000/mo charges. **Auto-provisioning after
payment is NOT built yet.** A customer who pays is *not* automatically given a workspace;
you must provision them manually (Hostinger VPS API → DNS-merge `<ws>.diffraction.in` →
`setup.sh`) until the payment webhook → provisioner exists. Keep `signup.html` unlinked
(soft-hold) until that automation is in place, or fulfil each sale by hand.
