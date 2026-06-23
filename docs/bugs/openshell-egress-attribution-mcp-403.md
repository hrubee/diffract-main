# OpenShell egress: the chat daemon's cross-netns egress is attributed `binary=-` → 403 (breaks MCP in chat)

**Severity:** High — makes HTTP MCP servers unusable from the chat agent unless the
connected host's egress rule explicitly admits the unknown-binary (`-`) attribution.

**Component:** OpenShell L7 forward proxy — process→binary attribution across the
sandbox/main network-namespace boundary.
**Version:** OpenShell `0.0.57`.
**Environment:** `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base` (Debian 13, Python 3.13),
Hermes agent `hermes gateway run`, on the live Diffract VPS.

---

## Summary

The Hermes chat daemon (`hermes gateway run`) runs in the **sandbox network namespace**
(`10.200.0.2`, behind a veth). Its only path to any external host is the OpenShell L7
forward proxy at `10.200.0.1:3128` in the **main namespace** (the daemon's env exports
`HTTPS_PROXY=http://10.200.0.1:3128` + CA bundles; there is no transparent NAT redirect in
the sandbox netns, and the daemon can reach *only* the proxy port and the privileged
`inference.local` RPC — nothing else).

When the daemon CONNECTs to `mcp.zapier.com:443` through that proxy, the proxy **cannot
trace the cross-netns connection back to a process/binary**, so it attributes it to
`binary=-` (unknown). The connected host's egress rule listed only concrete binaries
(the python interpreters), so `binary=-` matched nothing → **403** → the chat agent
registered **0 MCP tools**.

A process OpenShell *can* trace — anything in the **main** netns, e.g. a `docker exec`
child or `hermes mcp test` — is attributed to its real exe and allowed. That is why every
"fresh process" reproduction succeeded while the daemon failed.

## Proof (one instant, same host/user/binary/SDK/URL — only the caller's netns differs)

```sh
CID=<sandbox container>;  GW=$(pgrep -f "hermes gateway run")
URL="https://mcp.zapier.com/api/v1/connect?token=<valid>"

# (A) From INSIDE the daemon's netns, via the proxy, with the host's rule listing only
#     concrete binaries:                                   -> ProxyError: 403 Forbidden
docker exec -i "$CID" nsenter -t "$GW" -n env HTTPS_PROXY=http://10.200.0.1:3128 \
  SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem ... python -c '<list_tools(URL)>'

# (B) Add `-` (unknown binary) to that host's egress rule, then rerun (A): -> 21 tools OK
openshell policy update <sb> --add-endpoint mcp.zapier.com:443:full --binary -

# (C) A docker-exec / main-netns process (correctly attributed) was allowed all along: 21 tools
```

The single variable that flips (A) from 403 to 21 tools is whether the rule admits `-`.

## What was NOT the cause (ruled out along the way)

- **Token / SDK / CA / proxy env** — all fine; fresh-process repros list 21 tools, including
  with the daemon's *exact* minimal env.
- **Process age** (long-running daemon vs fresh process) — not it; the discriminator is the
  network namespace, not the process lifetime.
- **A stdio bridge subprocess** — does NOT help: any subprocess the daemon spawns lives in
  the same sandbox netns and is attributed `binary=-` just like the daemon. (Earlier theory;
  the bridge was removed.)
- **A loopback sidecar** — does NOT help: a correctly-attributed sidecar (started via
  `docker exec`) lands in the *main* netns, and the daemon cannot reach it — the gateway can
  reach only `10.200.0.1:3128`, not arbitrary ports. (Earlier theory; removed.)
- **Create-policy enforcement delay** — not real; the create policy is active at startup. The
  "delay" symptom was the persistent 403, not timing.

## Suggested upstream fix

Make the forward proxy resolve the originating binary for cross-netns CONNECTs (peer-cred /
conntrack → owning PID in the sandbox netns → `/proc/<pid>/exe`) and apply the same
per-binary allowlist, OR document that `binary=-` is the correct attribution for the
sandbox daemon and have operators scope an allow rule to it per host.

## Diffract fix (shipped)

The connected MCP server is configured **url-based** (`mcp_servers.<name>.url`), so the
daemon connects to it **in-process** using its own `HTTPS_PROXY` + CA env, and the
create-time `diffract_mcp` egress rule lists `-` alongside the python interpreters — scoped
to the connected MCP host(s) only. The daemon's startup discovery is then admitted and
registers the tools; the api_server (chat) agent, which rebuilds per request from the global
tool registry, picks them up. No bridge, sidecar, or gateway restart required.
- `NemoClaw/src/lib/onboard/initial-policy.ts` — `diffract_mcp` binaries include `{ path: "-" }`.
- `scripts/diffract-mcp-sync.sh` — emits url-based `mcp_servers` config + `-` in the egress binaries.

Verified end-to-end on-box: the chat agent lists all 21 Zapier tools and successfully created
a real Google Doc through the tool call.
