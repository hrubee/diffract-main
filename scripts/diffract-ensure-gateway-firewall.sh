#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Ensure the host firewall lets sandbox containers reach the OpenShell gateway.
#
# ROOT CAUSE this prevents (2026-06-09 outage): after a reboot, ufw came up with
# a default-deny INPUT policy and only 22/80/443 allowed. That silently blocked
# the INTERNAL container -> host:8080 gRPC traffic the sandbox supervisor uses to
# "fetch sandbox policy". The sandbox never reached Ready, the gateway never
# launched, and it surfaced downstream as endless chat 502s, gateway crash-loops,
# and "Something went wrong while setting up your sandbox" recreate failures —
# none of which point at the firewall.
#
# The rule below is interface-AGNOSTIC: it matches the docker bridge SUBNET, not
# a bridge name, so it survives docker recreating bridges with new names
# (br-<hash> changes across recreates; an `allow in on <iface>` rule would not
# match the bridge that actually carries the packets). `ufw allow` also PERSISTS
# the rule even when ufw is currently inactive and applies it on the next
# `ufw enable` — so running this at install time protects against ufw being
# enabled LATER (a reboot, a panel toggle), which is exactly what bit us.
#
# Idempotent and safe to run repeatedly. No-op on hosts without ufw. Never
# reloads ufw (adding a rule applies immediately when active; persists when not).
# ─────────────────────────────────────────────────────────────────────────
set -u

# OpenShell gateway INTERNAL gRPC port (sandbox supervisor <-> gateway). This is
# NOT the 8642 OpenAI-compat API — that one is host-loopback + forwarded and
# never crosses the docker bridge, so it is not what ufw was blocking.
GRPC_PORT="${DIFFRACT_GATEWAY_GRPC_PORT:-8080}"
# Docker's default address pools all live inside 172.16.0.0/12 (docker0 =
# 172.17.0.0/16, user-defined bridges = 172.18.0.0/16 and up). One subnet rule
# therefore covers every current and future docker bridge on the host.
DOCKER_SUBNET="172.16.0.0/12"

command -v ufw >/dev/null 2>&1 || exit 0

# `ufw show added` prints the `ufw allow ...` form of every added rule REGARDLESS
# of whether ufw is active, so this idempotency check is correct even when ufw is
# currently inactive (in which case `ufw status` would list nothing at all).
if ufw show added 2>/dev/null | grep -qF "from ${DOCKER_SUBNET} to any port ${GRPC_PORT}"; then
  exit 0
fi

if ufw allow from "${DOCKER_SUBNET}" to any port "${GRPC_PORT}" proto tcp >/dev/null 2>&1; then
  echo "[ensure-gateway-firewall] allowed ${DOCKER_SUBNET} -> :${GRPC_PORT}/tcp (internal gateway gRPC)"
fi
exit 0
