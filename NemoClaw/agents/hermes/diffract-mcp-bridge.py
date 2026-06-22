#!/usr/bin/env python3
"""stdio <-> streamable-http MCP bridge (Diffract).

WHY THIS EXISTS
---------------
The long-running Hermes daemon (`hermes gateway run`) makes its MCP HTTP connection
*in-process*. The OpenShell L7 egress proxy attributes that in-process connection to
``binary=-`` (unknown) and denies it (403) — even when the host is allowlisted and an
"any-binary" rule is approved. A *subprocess*, by contrast, is attributed to its real
binary (``/usr/bin/python3.13``) and is allowed. So we run the HTTP MCP client HERE, in a
subprocess the daemon spawns, and speak MCP over stdio back to the daemon. The daemon's
egress never leaves the box for MCP; only this subprocess does, and it's attributed
correctly. (See docs/bugs/openshell-egress-attribution-mcp-403.md.)

ROBUST TO THE CREATE-TIME EGRESS RACE
-------------------------------------
The daemon discovers MCP at *startup*, before the deploy flow applies the per-server MCP
egress allowlist. If we connected upstream eagerly, the first connect would 403 and the
daemon would register 0 tools (and the chat/api_server agent only picks up MCP tools at
startup, so a later reload wouldn't help it). Instead we serve stdio IMMEDIATELY (the
daemon's initialize succeeds) and connect upstream LAZILY, with retry, on each operation —
so by the time the daemon calls list_tools, the upstream connect keeps retrying until the
egress allowlist goes live.

Usage: diffract-mcp-bridge.py <streamable-http-url>
"""
import asyncio
import sys

from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

URL = sys.argv[1] if len(sys.argv) > 1 else ""
# Retry upstream long enough to outlast the create-time egress-enforcement delay:
# OpenShell enforces the create policy ~120s after sandbox create, while the daemon
# discovers MCP at startup. ~180s of retry (paired with connect_timeout/timeout: 200
# on the server config) lets the bridge connect the moment egress goes live, so the
# daemon registers the tools AT STARTUP and the chat (api_server) agent gets them.
_RETRIES = 90
_DELAY = 2.0


async def _run(op):
    """Open a fresh upstream session, run `op(session)`, retrying past the egress race."""
    last = None
    for _ in range(_RETRIES):
        try:
            async with streamablehttp_client(URL) as (read, write, _c):
                async with ClientSession(read, write) as up:
                    await up.initialize()
                    return await op(up)
        except Exception as exc:  # noqa: BLE001 — retry every failure (egress not live yet, transient)
            last = exc
            await asyncio.sleep(_DELAY)
    raise last if last is not None else RuntimeError("upstream MCP unavailable")


async def main() -> None:
    srv = Server("diffract-mcp-bridge")

    @srv.list_tools()
    async def _list_tools():
        async def op(up):
            return (await up.list_tools()).tools

        return await _run(op)

    @srv.call_tool()
    async def _call_tool(name, arguments):
        async def op(up):
            return (await up.call_tool(name, arguments)).content

        return await _run(op)

    opts = srv.create_initialization_options()
    async with stdio_server() as (read, write):
        await srv.run(read, write, opts)


if __name__ == "__main__":
    asyncio.run(main())
