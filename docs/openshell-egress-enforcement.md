# OpenShell Egress Enforcement — Findings & Upgrade Plan

**Status:** Root cause confirmed; fix verified on OpenShell v0.0.57; NemoClaw integration work
required before rollout.

## Problem

On the OpenShell version currently pinned by the blueprint (**0.0.39**), the sandbox network
policy does not actually enforce as intended, in two opposite directions:

1. **Approvals don't take effect.** Approving an outbound host (e.g. via the Diffract UI) does
   not make it reachable. Every non-inference destination is denied — including hosts with a
   correct preset rule (`pypi.org`). Only `inference.local` works, because the OpenShell router
   special-cases it and bypasses binary attribution.
2. **Denials are bypassable.** There is no network-layer egress lockdown: the sandbox container
   has a direct internet route, so any client that ignores the `http_proxy` env (raw sockets,
   proxy-unaware code) reaches the internet directly, skipping deny-by-default entirely.

Net: on 0.0.39, the network policy is effectively **advisory**, not enforced.

## Root cause (0.0.39)

OpenShell cannot attribute the **peer binary** of a proxied connection — it returns `-(0)`
(unknown) and the policy engine **fail-closes** on an unresolved binary, so no rule can match.
- HTTPS/CONNECT: hard error `failed to resolve peer binary: No ESTABLISHED TCP connection found
  for port …` before the rule is even evaluated.
- HTTP/forward: binary resolves to `-`, which matches no rule → `FORWARD denied`.

A correctly hand-written rule (explicit L7 `allow GET /**` + the binary listed, or even a
host-scoped rule with no binary constraint) still denies — confirming this is **not** a
rule-format/auto-proposer bug. It is in the OpenShell runtime, which Diffract bundles as a
compiled binary; it is **not fixable from Diffract's policy layer**. (Note: it is **not** a
missing `CAP_SYS_PTRACE` either — the supervisor already holds it and attribution still fails.)

## Fix — OpenShell v0.0.57 (verified)

Tested in an isolated v0.0.57 stack, exercising the workload the correct way (the supervisor's
isolated netns), with a deny-by-default policy + one approved host:

| Test | 0.0.39 | 0.0.57 |
|---|---|---|
| Approved host via proxy (HTTP) | denied (`-(0)`, FORWARD denied) | **200 ALLOWED** |
| Approved host via proxy (HTTPS) | denied (`failed to resolve peer binary`) | **200 ALLOWED** |
| Non-approved host via proxy | n/a | **denied on policy** (correct) |
| Direct egress, proxy unset | **leaks (200)** | **blocked** (no route / DNS) |
| Raw socket to a bare IP | would leak | **connection refused** |

Smoking-gun log line on 0.0.57 (binary now attributed, vs `-(0)` before):
```
HTTP:GET [INFO] ALLOWED /usr/bin/curl(PID) -> GET http://<host>/... [policy:<rule> engine:l7]
NET:OPEN [INFO] ALLOWED /usr/bin/curl(PID) -> <host>:443 [policy:<rule> engine:opa]
NET:OPEN [MED] DENIED /usr/bin/curl(PID) -> <other>:443 [reason: not allowed by any policy]
```

v0.0.57 also runs the workload in an **isolated network namespace whose only egress is the
proxy** (the L4/nftables enforcement from 0.0.44 / 0.0.50). That closes the direct-route bypass:
the supervisor logs `Creating network namespace …` and fails hard if it can't
(`proxy mode requires isolation`).

**Conclusion:** upgrading OpenShell to v0.0.57 fixes both the broken approvals and the bypass —
converting the network policy from advisory to enforced.

## Required NemoClaw integration work (it is NOT a version-number bump)

v0.0.57 changed the gateway auth model, so the blueprint pin cannot simply be moved:

1. **Gateway-minted sandbox JWT.** Generate/persist an Ed25519 keypair and configure
   `[openshell.gateway.gateway_jwt] { signing_key_path, public_key_path, kid_path, ttl_secs }`.
   The current bootstrap uses `OPENSHELL_DISABLE_GATEWAY_AUTH=true`
   (`src/lib/onboard/docker-driver-gateway-env.ts`), which v0.0.57 rejects for docker sandboxes.
2. **User auth.** Configure real user auth, or set
   `[openshell.gateway.auth] allow_unauthenticated_users = true` (enabling `gateway_jwt` also
   turns on user-request auth).
3. **Sandbox image deps.** The base image must ship `iproute2` (+ `iptables`/`nftables`), or the
   supervisor's netns creation fails. (The container already runs with `CAP_NET_ADMIN`/`CAP_SYS_ADMIN`.)
4. **Blueprint pin.** Bump `min/max_openshell_version` off `0.0.39` in `nemoclaw-blueprint/blueprint.yaml`.
5. **Re-validate** the full deploy and the messaging-credential-rewrite feature checks in
   `scripts/install-openshell.sh` against the new version.

## Validated vs. still-pending

- **Verified:** the OpenShell enforcement *mechanism* on 0.0.57 (attribution works; approved host
  reachable; non-approved + raw/direct egress blocked) — using a hand-written policy and `curl`.
- **Pending before rollout:** (a) the real Diffract UI **approve-flow** end-to-end on 0.0.57
  (denial → auto-proposed rule → approve → applied), (b) the **Python** agent binary path (the
  real agent is Python, not curl), (c) a clean NemoClaw deploy on 0.0.57 with the changes above.

## Suggested rollout order

1. Implement the gateway-JWT + user-auth config and the image dep in NemoClaw.
2. Bump the blueprint pin; run a full clean deploy on a throwaway sandbox.
3. Validate with the matrix above (approved reachable; non-approved denied; raw-socket bypass blocked).
4. Only then promote; keep a 0.0.39 rollback path until validated.
