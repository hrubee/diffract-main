# OpenShell 0.0.39 → 0.0.57 Upgrade — Execution Plan

**Goal (this effort):** make the **always-on gateway agent** (the one the Diffract dashboard chat
talks to) able to use credential-injected tools (e.g. `ghl`), and convert the network policy from
advisory to **enforced** (close the raw-socket data-exfil bypass). One upgrade, both wins.

**Why an upgrade is required (not a config tweak):** on 0.0.39 the long-running
`hermes gateway run` daemon has no proxy, no MITM CA, and no `openshell:resolve:` placeholders in
its env (verified via `/proc/<pid>/environ`) — so the dashboard agent sends the literal
placeholder → GHL returns `401 Invalid JWT`.

> **CLARIFICATION (2026-06-10): the exec/headless path DOES work for `ghl` on 0.0.39 — given the
> named-binary egress policy AND a valid token. The current blocker is a dead token, not OpenShell.**
> Investigated live. An exec session gets the placeholders (`GHL_PRIVATE_TOKEN=openshell:resolve:...`,
> `GHL_LOCATION_ID`) AND the full proxy/CA env (`HTTPS_PROXY=http://10.200.0.1:3128`,
> `NODE_EXTRA_CA_CERTS`). The `hermes` sandbox has a correct egress rule `ghl-api`
> (`services.leadconnectorhq.com:443` `access: full`, binary `/usr/local/bin/node`), and `ghl` runs
> as node, so attribution succeeds — the gateway log shows
> `NET:OPEN ALLOWED /usr/local/bin/node(PID) -> services.leadconnectorhq.com:443 [policy:ghl-api]`
> then `HTTP:GET ALLOWED GET .../contacts/`. The request reaches GHL; GHL returns `401 Invalid JWT`.
> On 2026-06-08 this *exact* path returned real CRM data and credential substitution was confirmed
> (see [[egress-approval-broken-openshell-attribution]]), so the pipeline works — the one thing that
> changed is the token. **Conclusion: the stored GHL Private Integration Token is revoked/rotated/
> expired.** Fix: re-connect a fresh token (Tools tab or `openshell provider update ghl`), then a
> `ghl contacts list` via exec should return real data again — no upgrade needed for the headless path.
> (The 2026-06-06 "attribution always fail-closes" finding applies to the `-` wildcard / unnamed
> binary; naming the specific binary path works on 0.0.39.)
>
> **Consequence for the cutover:** 0.0.57 is needed **only for ghl-in-CHAT** (the always-on
> `hermes gateway run` daemon still has no placeholder injection — that part of the premise stands).
> It is NOT needed for headless ghl. GATE before the destructive cutover regardless: confirm a
> *valid* token first (the provider store is write-only and can't be read back to test) — don't cut
> over only to hit a `401` from a dead token.

See `openshell-egress-enforcement.md` for the egress-enforcement findings; this plan adds the
gateway-credential-injection angle that the upgrade must also fix.

**Current state**
- Live demo box: OpenShell `0.0.39` (`/usr/bin/openshell`).
- Isolated 0.0.57 binaries already staged on the VPS at `/opt/ostest/` (openshell,
  openshell-gateway, openshell-sandbox) — **does not touch the live demo**.
- Pin: `NemoClaw/nemoclaw-blueprint/blueprint.yaml:5-6` (`min/max_openshell_version: "0.0.39"`).
- Auth bootstrap: `NemoClaw/src/lib/onboard/docker-driver-gateway-env.ts:79`
  (`OPENSHELL_DISABLE_GATEWAY_AUTH: "true"`).

---

## Phase 0 — GATE: does 0.0.57 inject creds into the *gateway*? ✅ PASSED (2026-06-08)

**RESULT: PASSED — the upgrade fixes the dashboard tool-use.** Validated in a fully isolated
`docker:dind` lab (own PID namespace + own Docker daemon; the live demo was never touched). Ran the
real 0.0.57 gateway, created a sandbox from a minimal debian-slim image (iproute2/nftables) with a
`generic` provider (`TEST_TOKEN=ZZSECRETVALUE99`) attached **at create**, then:

- **Delivery ✅** — read `/proc/<pid>/environ` of every sandbox process: the long-running workload
  daemon (`sleep infinity`, pid 24 — the gateway analog) **had** the `openshell:resolve:...`
  placeholder in its env, exactly like an exec session. On 0.0.39 the gateway daemon had *nothing*
  — that was the root cause. The supervisor (pid 1) correctly had no placeholder.
- **Resolution ✅** — from the sandbox, `curl https://postman-echo.com/headers -H "Authorization:
  Bearer <placeholder>"` came back echoed as `"authorization":"Bearer ZZSECRETVALUE99"` — the proxy
  substituted the placeholder → real secret at egress.

So on 0.0.57 a long-running daemon both **receives** the placeholder and gets it **resolved** at the
proxy — the two things 0.0.39 failed at. Final confirmation with the *actual* hermes gateway image
happens at Phase 2 (real deploy); the OpenShell-mechanism gate is cleared.

### ✅ ghl-in-chat end-to-end with the REAL provider — PASSED (2026-06-10)

The Phase-0 result above used a *synthetic* provider (`TEST_TOKEN`) against postman-echo. Before
committing to the live cutover, the **real GHL provider** was validated end-to-end in the isolated
`os057-lab` dind (own docker daemon — zero live-box impact), closing the last unverified assumption:

- **Daemon injection (the 0.0.39 gap), real provider:** read the long-running workload daemon's
  (`sleep infinity`, pid 24) `/proc/<pid>/environ` — it has the FULL set: `GHL_PRIVATE_TOKEN` +
  `GHL_LOCATION_ID` placeholders, `HTTPS_PROXY=http://10.200.0.1:3128` (+ all proxy vars),
  `NODE_EXTRA_CA_CERTS` + `SSL_CERT_FILE` (the MITM CA). On 0.0.39 the daemon had *none* of this.
- **Substitution + egress, real provider + real host:** a real `GET services.leadconnectorhq.com/contacts/`
  from the workload netns (placeholder Bearer + placeholder locationId, egress policy binary
  `/usr/bin/curl`) returned **real CRM data** (real contacts, `locationId` matched, `total: 58379`).

So on 0.0.57 the always-on daemon gets the complete credential+proxy+CA injection AND substitution
works for the real GHL provider — i.e. **ghl-in-chat will work after the cutover.** Lab teardown:
provider/sandbox deleted, dind stopped, token files removed; live demo confirmed untouched (8642=200).

---

### Original gate procedure (for reference)

The prior 0.0.57 validation only proved
egress *enforcement* with `curl`; it never proved credential *injection* reaches a long-running
daemon. On the isolated `/opt/ostest` 0.0.57 stack:

1. Stand up a sandbox with a `generic` provider attached (placeholder credential) **before** the
   workload boots.
2. Start a long-running process (proxy of the gateway) and verify, from *its* env / a child it
   spawns: (a) the `openshell:resolve:` placeholder is present, and (b) a request it makes is
   substituted to the real value at the proxy and reaches the target host.
3. Repeat with the **Python** agent path, not just `curl`/node (the real agent is Python).

- ✅ **Pass** (placeholder present + substituted for the daemon) → the upgrade fixes the dashboard.
  Proceed to Phase 1.
- ❌ **Fail** → 0.0.57's netns isolation forces traffic through the proxy but doesn't *deliver* the
  placeholder to the daemon. **STOP and report** — we'd need provider creds wired at sandbox-create
  into the workload env, a separate change; do not start integration work on a false premise.

---

## Phase 1 — NemoClaw integration (≈1–2 days, all git-reversible, no live impact)

### Concrete integration spec (investigated 2026-06-09)

**Status:** image deps done (`Dockerfile`, committed — pin still 0.0.39, no live effect). Exact
remaining shape, nailed down by reading the 0.0.57 binary + NemoClaw source:

- **0.0.57 auth is configured via a TOML config file passed with `--config`, NOT env vars.**
  NemoClaw currently starts the gateway env-only, no config file. The TOML needs two sections
  (validated working in the `/opt/ostest` lab):
  ```toml
  [openshell.gateway.auth]
  allow_unauthenticated_users = true            # else 0.0.57 requires OIDC/mTLS for the docker gateway
  [openshell.gateway.gateway_jwt]
  ttl_secs = 3600
  signing_key_path = "<state>/jwt/signing.pem"  # Ed25519
  public_key_path  = "<state>/jwt/public.pem"
  kid_path         = "<state>/jwt/kid"
  ```
- **`OPENSHELL_DISABLE_GATEWAY_AUTH` is not a 0.0.57 flag** (absent from `--help`) — harmless if left
  (ignored), but drop it for cleanliness. (`docker-driver-gateway-env.ts`.)
- **Launch wiring (`docker-driver-gateway-launch.ts`):** the gateway runs two ways — direct binary,
  or inside a glibc compat container (`docker run … <image> <gatewayBin>`). For 0.0.57, both paths
  must: (a) generate the Ed25519 keypair + `kid` into `<stateDir>/jwt/` if absent, (b) write the
  TOML, (c) append `--config <toml>`. The compat-container path must also `--volume`-mount the
  jwt dir + the TOML read-only (they already mount `stateDir` rw, so placing both under `stateDir`
  means no extra mounts).
- **Version-gate everything on `openshell >= 0.0.57`** so the 0.0.39 path is untouched until the pin
  flips.
- Keygen: `openssl genpkey -algorithm ed25519` (or node `crypto.generateKeyPairSync('ed25519')`);
  `kid` = a stable hash of the public key.

### Original task list

1. **Gateway-minted JWT.** Generate + persist an Ed25519 keypair at image build / first boot;
   configure `[openshell.gateway.gateway_jwt] { signing_key_path, public_key_path, kid_path,
   ttl_secs }`.
2. **Drop the auth-disable shortcut.** Replace `OPENSHELL_DISABLE_GATEWAY_AUTH: "true"`
   (`docker-driver-gateway-env.ts:79`) with the JWT config above + `[openshell.gateway.auth]
   allow_unauthenticated_users = true` (0.0.57 rejects the disable flag for docker sandboxes).
3. **Sandbox image deps.** Add `iproute2` (+ `nftables`/`iptables`) to the hermes sandbox base
   image, or the supervisor's netns creation fails (`proxy mode requires isolation`). The
   container already runs `CAP_NET_ADMIN`/`CAP_SYS_ADMIN`.
4. **Bump the pin.** `blueprint.yaml:5-6` → `0.0.57`; update the sandbox base-image ref if the
   0.0.57 line requires a matching base.
5. **Installer.** Point `scripts/install-openshell.sh` at the 0.0.57 release; keep 0.0.39 fetchable
   for rollback.

## Phase 2 — Clean throwaway deploy + full validation (≈1 day)

Deploy NemoClaw with the Phase-1 changes onto a **throwaway** sandbox and run the matrix:

| Check | Expected on 0.0.57 |
|---|---|
| Approved host via proxy (HTTP + HTTPS) | reachable (binary attributed, not `-(0)`) |
| Non-approved host via proxy | denied on policy |
| Direct egress / raw socket (proxy unset) | **blocked** (netns isolation) |
| **Dashboard tool-use:** `ghl` via the `:8642` gateway | **returns real contacts** (the Phase-0 win, end-to-end) |
| Diffract UI approve-flow | denial → auto-proposed rule → approve → reachable |

## Phase 3 — Live cutover (≈0.5 day, the ONLY destructive step — gated on your go)

1. Back up live sandbox state (working files + provider/policy inventory).
2. Swap `0.0.39 → 0.0.57` on the live box; redeploy from the bumped blueprint.
3. Re-attach providers + re-apply tool egress policies (tokenless — providers persist).
4. Re-run the Phase-2 matrix on the live box.
5. **Rollback path kept ready:** 0.0.39 binaries retained + a one-command pin revert + redeploy;
   revert window is minutes, not a rebuild.

---

## Effort & risk

- **Effort:** ~3–5 focused days total; Phase 0 (~0.5 day) gates the rest.
- **Risk:** medium-high — it's the security foundation — **mitigated** by: isolated validation
  before any live change, git-reversible code, a throwaway-deploy gate, and a kept 0.0.39 rollback.
- **Blast radius until Phase 3:** zero on the live demo (all isolated / in-repo).

## Bonus the upgrade also delivers

Closes the raw-socket / `execute_code` direct-egress bypass (data-exfil gap) — so a
prompt-injected agent can no longer exfiltrate via a raw socket. The "credential theft impossible"
claim becomes "credential theft impossible **and** egress confined to approved hosts."
