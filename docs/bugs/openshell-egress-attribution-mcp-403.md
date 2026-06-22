# OpenShell egress bug: daemon in-process egress attributed `binary=-` → 403 (breaks MCP in chat)

**Severity:** High — makes HTTP MCP servers unusable from the chat agent, and undermines
the egress-approval UX (approving a host does not let the agent reach it).

**Component:** OpenShell L7 egress proxy / gateway (process→binary attribution).
**Version:** OpenShell `0.0.57`.
**Environment:** `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base` (Debian 13, Python 3.13),
Hermes agent `hermes gateway run`, sandbox id `1bbe4e74-...` on the live Diffract VPS.

---

## Summary

A **fresh process** inside the sandbox can reach an allowlisted external host through the
proxy, but the **long-running Hermes daemon** (`hermes gateway run`) cannot reach the *same*
host with the *same* binary, user, and request — it gets **`403 Forbidden`** every time.

The proxy attributes the daemon's outbound connection to **`binary=-` (unknown)**, treats it
as un-approved egress, and denies it. Approving the resulting draft chunk — even as a broad
**any-binary** rule (`binaries=[-]`) — does **not** unblock the daemon: it keeps 403-ing and
re-generating mechanistic chunks that are auto-rejected as "already covered".

## Why it matters

- HTTP MCP servers (e.g. Zapier MCP at `https://mcp.zapier.com/...`) connect from **inside**
  the daemon process. Because the daemon's egress is attributed `binary=-`, the MCP client
  gets 403 at startup → `registered 0 tool(s)` → the agent has no MCP tools in chat.
- It defeats the core egress-approval value prop: the dashboard "Rules" approval flow adds an
  allow rule, the user clicks Approve, and the agent **still can't reach the host**.

## Minimal repro (same sandbox, same user, same binary, same SDK, same URL, same moment)

```sh
CID=<sandbox container>
# 1) Fresh process AS THE DAEMON'S USER (`sandbox`) — the exact MCP client path:
docker exec -u sandbox -e HOME=/sandbox "$CID" /opt/hermes/.venv/bin/python - <<'PY'
import asyncio
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession
URL = "https://mcp.zapier.com/api/v1/connect?token=<valid>"
async def main():
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            t = await s.list_tools()
            print("OK", [x.name for x in t.tools][:5])
asyncio.run(main())
PY
# => 200, lists ~12 tools (google_docs_*, linkedin_*). WORKS.

# 2) The daemon (`hermes gateway run`, PID, user `sandbox`, /proc/<pid>/exe -> /usr/bin/python3.13)
#    doing the identical discover_mcp_tools() via the reload.mcp RPC:
#    => tools/mcp_tool: Failed to connect to MCP server 'zzaiier': 403 Forbidden
#       MCP: registered 0 tool(s) from 0 server(s) (1 failed)   -- EVERY TIME.
```

Both processes run as user `sandbox`, both resolve to `/usr/bin/python3.13` (which is in the
egress allowlist), both target `mcp.zapier.com:443`. Only the fresh process succeeds.

## Proxy-log evidence (`openshell-gateway.log`)

```
ApproveDraftChunk: ... rule_name=allow_mcp_zapier_com_443 host=mcp.zapier.com port=443
  hit_count=4 prev_status=pending
CONFIG:APPROVED ... add-rule allow_mcp_zapier_com_443 endpoints=[mcp.zapier.com:443]
  binaries=[-]  [version:v8]
# ...daemon retried after the approval (v8 active)...
SubmitPolicyAnalysis: Auto-rejected incoming mechanistic chunk: endpoint already covered
  by an approved chunk host=mcp.zapier.com port=443 binary=-
```

Key facts: the daemon's egress carries **`binary=-`**, and even after an **any-binary**
(`binaries=[-]`) allow rule is approved and active (policy v8), the daemon's connection is
still denied and produces another `binary=-` mechanistic chunk.

## Root cause (hypothesis)

The proxy resolves the connecting process's binary correctly for processes whose `exec` it
traces (fresh `docker exec` children → `/usr/bin/python3.13`), but attributes the
**long-running daemon** (launched at sandbox boot via `nemoclaw-start` → step-down → `hermes
gateway run`) as `binary=-` (unknown). Two sub-issues compound:

1. **Attribution miss for the daemon process** — its in-process egress is not mapped to its
   real exe (`/usr/bin/python3.13`), so it matches no binary-scoped allow rule.
2. **`binaries=[-]` allow rules don't admit `binary=-` egress** — an approved any-binary rule
   for the host still denies the unknown-binary connection, so the operator-facing "Approve"
   action has no effect for the daemon.

## What is NOT the cause (ruled out)

- **Token** — valid (the fresh-process repro lists all tools; also 200 directly from the host).
- **MCP SDK** — `mcp==1.26.0` with `mcp.client.streamable_http` is installed and imports fine.
- **Egress reachability / proxy MITM** — the fresh process connects through the same proxy.
- **Server config** — `mcp_servers.zzaiier` is present and `enabled: true` in the daemon's
  `/sandbox/.hermes/config.yaml`.
- **Reload mechanism** — the `reload.mcp` JSON-RPC (`{confirm:true}`) re-runs
  `discover_mcp_tools()` in-process and re-attempts the connection; it still hits the 403.

## Suggested fix direction

- Attribute the daemon's in-process egress to its real exe (e.g. resolve via the connecting
  task's owning PID `/proc/<pid>/exe` in the sandbox mount ns), OR
- Treat an approved `binaries=[-]` (any-binary) allow rule as admitting `binary=-`
  (unknown-attribution) egress for that host — so operator approval actually works.

Either makes HTTP MCP servers usable from chat without weakening per-binary egress for
processes that *can* be attributed.
