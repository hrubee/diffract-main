#!/usr/bin/env python3
"""
Diffract local payments dev server (stdlib only — no installs).

Serves the static marketing site + signup page AND a /api/checkout endpoint that
creates a Dodo Payments checkout session for the Diffract subscription and returns
its hosted checkout URL. The signup page posts {workspace,email} here, then the
browser is redirected to Dodo to pay ₹2000/mo.

  run:   python3 website/local-dev-server.py
  then:  http://localhost:8088/  (landing) · /signup.html (signup)

The Dodo API key is read at runtime from ~/.diffract-dodo.env (gitignored) — it is
NEVER hard-coded here. Product + endpoint are the live ones created this session.
"""
import http.server, json, re, pathlib, subprocess

ROOT       = pathlib.Path(__file__).parent
PORT       = 8088
PRODUCT_ID = "pdt_0NgoqgyAZmJmzhod4sk1f"          # Diffract — ₹2000/mo (live)
DODO_BASE  = "https://live.dodopayments.com"
ENV_FILE   = pathlib.Path.home() / ".diffract-dodo.env"

# Reserved subdomains — MUST mirror signup.html + the provisioner.
RESERVED = {
    "app","www","ftp","api","admin","mail","root","ns","ns1","ns2","cdn","static",
    "assets","dashboard","status","blog","support","help","docs","console","portal",
    "login","signup","sign-up","dev","staging","test","demo","mx","smtp","webmail",
    "vpn","git","@",
}

def load_key() -> str:
    if not ENV_FILE.exists():
        raise RuntimeError(f"missing {ENV_FILE} (DODO_PAYMENTS_API_KEY=...)")
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("DODO_PAYMENTS_API_KEY="):
            v = line.split("=", 1)[1].strip()
            if v:
                return v
    raise RuntimeError("DODO_PAYMENTS_API_KEY not set in " + str(ENV_FILE))

DODO_KEY = load_key()

def slugify(v: str) -> str:
    v = (v or "").lower().strip()
    v = re.sub(r"[^a-z0-9-]+", "-", v)
    v = re.sub(r"-+", "-", v).strip("-")
    return v

def valid_workspace(slug: str) -> bool:
    return bool(slug) and 3 <= len(slug) <= 30 and slug not in RESERVED

def valid_email(e: str) -> bool:
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", e or ""))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, fmt, *args):
        print("  " + (fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/api/checkout", "/api/checkout.php"):
            return self.send_error(404, "Not Found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON body"})

        workspace = slugify(data.get("workspace", ""))
        email = (data.get("email") or "").strip()
        if not valid_workspace(workspace):
            return self._json(400, {"error": "invalid or reserved workspace name"})
        if not valid_email(email):
            return self._json(400, {"error": "invalid email"})

        payload = {
            "product_cart": [{"product_id": PRODUCT_ID, "quantity": 1}],
            "return_url": f"http://localhost:{PORT}/signup.html?paid=1&ws={workspace}",
            "metadata": {"workspace": workspace, "email": email,
                         "name": (data.get("name") or "").strip()},
        }
        # Call Dodo via curl (uses the system CA store — avoids macOS python.org
        # SSL cert issues). The API key is a curl argv arg, never shell-interpolated.
        try:
            cp = subprocess.run(
                ["curl", "-s", "-m", "25", "-X", "POST", f"{DODO_BASE}/checkouts",
                 "-H", f"Authorization: Bearer {DODO_KEY}",
                 "-H", "Content-Type: application/json",
                 "-d", json.dumps(payload)],
                capture_output=True, text=True, timeout=30,
            )
            if cp.returncode != 0:
                return self._json(502, {"error": "curl failed", "detail": cp.stderr[:300]})
            resp = json.loads(cp.stdout or "{}")
            url = resp.get("checkout_url")
            if not url:
                return self._json(502, {"error": "no checkout_url from Dodo", "raw": resp})
            print(f"  -> checkout for '{workspace}.diffraction.in' ({email}) -> {url}")
            return self._json(200, {"url": url, "workspace": workspace})
        except Exception as e:
            return self._json(502, {"error": f"Dodo request failed: {e}"})


if __name__ == "__main__":
    print(f"\n  Diffract local payments server")
    print(f"  ─────────────────────────────")
    print(f"  landing : http://localhost:{PORT}/")
    print(f"  signup  : http://localhost:{PORT}/signup.html")
    print(f"  product : {PRODUCT_ID} (Diffract ₹2000/mo, LIVE)")
    print(f"  key     : loaded from {ENV_FILE}\n")
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
