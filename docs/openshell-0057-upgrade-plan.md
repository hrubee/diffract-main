# OpenShell 0.0.39 → 0.0.57 Upgrade — Execution Plan

**Goal (this effort):** make the **always-on gateway agent** (the one the Diffract dashboard chat
talks to) able to use credential-injected tools (e.g. `ghl`), and convert the network policy from
advisory to **enforced** (close the raw-socket data-exfil bypass). One upgrade, both wins.

**Why an upgrade is required (not a config tweak):** on 0.0.39 credential injection + the MITM
egress proxy exist **only inside `openshell sandbox exec` sessions**. The long-running
`hermes gateway run` daemon has no proxy, no MITM CA, and no `openshell:resolve:` placeholders in
its env (verified via `/proc/<pid>/environ`) — so the dashboard agent sends the literal
placeholder → GHL returns `401 Invalid JWT`. The CLI/headless path (`openshell sandbox exec --
hermes -z`) works because it runs *inside* the injected session. See
`openshell-egress-enforcement.md` for the egress-enforcement findings; this plan adds the
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
