# Connecting External Software to the Agent — Architecture

**Status:** Design note. Describes the existing, proven path (the `diffract-tools.json`
registry, wired end-to-end for one tool) and the path to enterprise SaaS at scale.
Grounded in the code as of this writing — see file references throughout.

## The one sentence to remember

> **We connect _to_ Hermes, but we connect _through_ OpenShell.**

Hermes is the **consumption plane** — it's where the agent learns a tool exists and decides
to call it. OpenShell is the **connection plane** — it's where the credential lives and where
egress is enforced. The agent never holds the real secret, and it cannot reach any host that
OpenShell hasn't allowlisted. That split is not an implementation detail; it _is_ the product.

This matters because the intuition "we want to connect to Hermes" is only half the story. You
make a tool _usable_ on the Hermes side, but you make it _connected_ (authenticated + reachable)
on the OpenShell side. Every real integration touches both planes, and the security-critical
half is OpenShell's.

## Why "through OpenShell" is forced, not chosen

The sandbox runs in its own network namespace (netns) with **no route to the internet except
the OpenShell L7 MITM proxy**. There is no second exit. This is the 0.0.57 lockdown that made
egress policy actually enforce (see `docs/openshell-egress-enforcement.md` — on 0.0.39 the
policy was merely advisory and bypassable via raw sockets).

Consequence: **every byte any process in the sandbox sends outbound crosses OpenShell.** A
baked CLI, a Node script, a Python SDK, an MCP subprocess — all of them. So OpenShell is the
universal choke point where two things happen on every outbound call:

1. **Host allowlisting** — the destination must be an approved host attributed to the calling
   binary, or the connection is denied at the network layer.
2. **Credential substitution** — the sandbox carries only a *placeholder*
   (`openshell:resolve:env:...`); the proxy swaps in the real secret at the edge, in headers
   **and** query params. The real value never enters the sandbox.

That's why the answer routes through OpenShell regardless of how Hermes invokes the tool.

```
┌─────────────────────────── sandbox (netns, no direct internet) ───────────────────────────┐
│                                                                                            │
│   Hermes agent ──calls──> tool (baked CLI  |  MCP subprocess  |  SDK)                       │
│        ▲                              │                                                     │
│        │ "tool exists,               │ outbound HTTPS, carries PLACEHOLDER credential       │
│        │  pre-authenticated"          ▼                                                     │
│   SKILL.md / MCP catalog      ┌──────────────────┐                                          │
│   (advertise)                 │  netns: only exit │                                          │
│                               │  is the proxy     │                                          │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │
                            ┌────────────▼─────────────┐   host-side secret store
                            │  OpenShell L7 MITM proxy  │◄── generic provider holds REAL value
                            │  • allowlist by host+bin  │    (env-resolved, never in sandbox)
                            │  • swap placeholder→real  │
                            └────────────┬─────────────┘
                                         │ only to allowlisted hosts
                                         ▼
                               api.stripe.com / *.atlassian.net / ...
```

## The two planes, concretely

### Connection plane — OpenShell (the hard, security-critical half)

For any tool, three facts must be established, and they live with OpenShell:

| Fact | What it is | Where it's set |
|---|---|---|
| **Egress hosts** | the exact domains the tool talks to (`api.stripe.com`, `*.atlassian.net`) | `apiHosts` in the registry → an OpenShell policy endpoint rule |
| **Credential placement** | the real secret on the host as a `generic` provider placeholder; sandbox sees only the placeholder | `secretEnv`/`configEnv` → `openshell provider create/update` |
| **Binary attribution** | which executable is allowed to use that egress/credential | `binaries` → policy `--binary` |

This is the work that does **not** get easier by changing how the agent calls the tool. It is
the same for a CLI and for an MCP server. It is also the part worth selling: a jailbroken agent
still can't exfiltrate the key or call an un-approved endpoint.

### Consumption plane — Hermes (two invocation surfaces)

How the agent actually invokes the tool. Two surfaces:

1. **Baked CLI + skill (proven today).** A third-party CLI is cloned/built into the image and a
   Hermes `SKILL.md` advertises it. The agent runs it like any shell tool; its outbound calls
   carry the placeholder and are mediated by OpenShell as above.
2. **MCP client (`mcp_servers`) — capability exists in Hermes core, NOT wired in Diffract today.**
   Hermes supports stdio + HTTP MCP servers and a full OAuth 2.1 flow. This is the natural lane
   for enterprise SaaS that ships an MCP server (Linear, Sentry, Atlassian, Asana, Figma,
   Stripe, Slack). It is currently **dormant** — nothing in NemoClaw configures `mcp_servers`,
   so adopting it is a build project, not a config edit.

Both surfaces still exit through OpenShell. The difference is **where the credential sits** (see
the OAuth caveat below).

## The proven path today: the `diffract-tools.json` registry

A tool is **one JSON entry** in `NemoClaw/agents/hermes/diffract-tools.json`, describing four
layers. The registry's own `$comment` is the source of truth; summarized:

| Layer | Fields | Consumed by | When |
|---|---|---|---|
| **INSTALL** | `repo`/`ref`/`kind`/`patch`/`build`/`entry`/`bin` | `install-diffract-tools.sh` | image build — bakes CLI into `/sandbox/.diffract-tools/<name>`, puts `<bin>` on PATH |
| **CONNECT** | `secretEnv`/`configEnv`/`apiHosts`/`binaries`/`authHeader` | `diffract-tool-connect.sh` | runtime — OpenShell `generic` provider → placeholder in sandbox → real secret at egress; egress allowlisted to `apiHosts`, attributed to `binaries` |
| **ADVERTISE** | optional `skill` object (`name`/`title`/`summary`/`tags`/`examples`) | `advertise-diffract-tools.sh` | image build — emits Hermes `SKILL.md` under `/sandbox/.hermes/skills/diffract-tools/<name>` so the agent *discovers* the tool, pre-authenticated |
| **PATCH** | optional `patch` shell hook | install step | proxy-compat fixups (e.g. an axios Node tool needs `adapter:'fetch'`, because egress is an MITM proxy and only undici/fetch honors it) |

**Add a tool = add an entry. No Dockerfile edit.** Supporting machinery already exists:

- `scripts/diffract-tool-connect.sh` — wire one tool's credential + egress into a sandbox.
- `scripts/diffract-tool-add.sh` — live-add a tool to a *running* sandbox (clone+build+advertise
  via the baked scripts).
- `scripts/diffract-tool-sync.sh` — reconcile the registry against the actually-connected set.
- `setup.sh` stages the registry to `/usr/local/share/diffract/diffract-tools.json` and installs
  `diffract-tool-connect.sh` to `/usr/local/bin`.

**Proven status:** exactly one tool (`ghl`, the GoHighLevel CRM CLI) is wired end-to-end and
validated through the enforced sandbox. The mechanism is general; the coverage is one.

> ⚠️ **0.0.57 create-time binding.** Inference and tool credentials are injected into the chat
> daemon at sandbox **create**. Connecting a tool to an already-running sandbox works for exec
> sessions but the chat agent won't see it until the sandbox is recreated. Plan tool rollouts
> as part of (re)provisioning, not as a hot-add for the chat path.

## A second existing mechanism: the Nous managed-tool gateway

`NemoClaw/agents/hermes/host/managed-tool-gateway-matrix.json` routes a **fixed catalog** of
Nous first-party tools (firecrawl, browser-use, fal, openai-audio, modal) through a **host-side
broker**. The upstream key stays on the host; the broker translates
`sandboxAuthHeaders → upstreamAuthHeader` and allowlists egress. Excellent security shape — same
"secret never enters the sandbox" guarantee — but it is a curated catalog, **not** a general
"connect any SaaS" path. Useful as a pattern to copy, not a thing to point arbitrary tools at.

## The enterprise-auth reality (the real fork in the road)

Enterprise tools split by auth type, and that split decides the mechanism:

- **API-key tools (Stripe, HubSpot, Notion, internal REST, Linear's API-key mode, …): easy.**
  A static key fits the placeholder model perfectly — host-side `generic` provider, proxy
  injects at egress, secret never in the sandbox. Use the registry path. This covers a large
  fraction of what companies actually want connected.

- **OAuth2 tools (Jira/Atlassian, Slack, Asana, Salesforce-style): the tradeoff.**
  Hermes' MCP `auth: oauth` *handles the protocol* (discovery, dynamic client registration,
  PKCE, refresh, step-up) — but it **caches the live access/refresh token inside the sandbox**
  at `~/.hermes/mcp-tokens/<server>.json`. That **breaks the host-side-secret guarantee**: a
  real, refreshable credential now sits in the sandbox filesystem — exactly what the
  placeholder/broker model exists to prevent.

So MCP buys protocol convenience at the cost of the strongest security claim. **That tension is
the central design decision for enterprise OAuth tools**, not a footnote. Options to resolve it
(in rough order of effort):
1. Use API-key auth where the vendor supports it (keeps the guarantee).
2. Front the MCP/OAuth server with a **host-side broker** (extend the managed-gateway pattern) so
   the token lives on the host and the sandbox sees only a broker session — preserves the
   guarantee, more to build.
3. Accept token-in-sandbox for a given tool as a deliberate, documented exception.

## Recommendation

1. **Lead with the proven path.** First wave of enterprise tools = registry entries + `generic`
   provider placeholder. Preserves "agent never holds the secret," already validated through
   enforcement, covers most API-key SaaS.
2. **De-risk MCP with a single spike, not a platform bet.** Wire **one** MCP server (e.g. Linear)
   end-to-end: add `mcp_servers` to the Hermes config, define its egress allowlist, push OAuth
   through the *enforced* sandbox, and verify both that the agent can call it **and** that nothing
   escapes the netns. Decide the token-in-sandbox tradeoff explicitly once it's observable.
3. **Name the build gap to productize this.** To go from "engineer adds a JSON entry" to "user
   connects an integration," the missing pieces are: a dashboard **Connect integration** flow
   (bones exist in `diffractui/.../api/tools/add`), per-integration **egress + credential wiring**,
   and **headless OAuth** handling (OAuth-over-SSH paste-back) for servers that can't open a
   browser.

This keeps faith with the standing rule — a *general* solution, not a GHL-shaped band-aid. The
registry + placeholder model already generalizes; the only genuinely new capability is the
OAuth/MCP lane, and it should be earned with a single-tool spike before any platform commitment.

## File reference

| Concern | Path |
|---|---|
| Tool registry (4-layer entries) | `NemoClaw/agents/hermes/diffract-tools.json` |
| Connect one tool (credential + egress) | `scripts/diffract-tool-connect.sh` |
| Live-add to a running sandbox | `scripts/diffract-tool-add.sh` |
| Reconcile registry ↔ connected | `scripts/diffract-tool-sync.sh` |
| Baked install / advertise (in image) | `install-diffract-tools.sh` / `advertise-diffract-tools.sh` |
| Nous managed-tool broker (first-party) | `NemoClaw/agents/hermes/host/managed-tool-gateway-matrix.json` |
| Egress enforcement findings (why netns matters) | `docs/openshell-egress-enforcement.md` |
| Dashboard add-tool flow (build-gap bones) | `diffractui/src/app/api/tools/add/route.ts` |
