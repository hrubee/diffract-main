export const dynamic = "force-dynamic";

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────
// MCP API — connect an MCP server (Zapier, Notion, …) to the Hermes agent.
//
// MODEL (token-in-Hermes, operator-selected): admin-session gated; the server's
// secret is extracted here and passed to the connect script ONLY via the child
// env (never argv, never logged, never returned). The connect script writes the
// REAL token directly into the Hermes mcp_servers config and keeps ONLY the
// OpenShell egress allowlist (required so the sandbox can reach the MCP host —
// egress is deny-by-default). No OpenShell secret-provider / placeholder rewrite.
// Tradeoff: the secret lives in the sandbox config + a root-only host record.
// execFile uses argv arrays (no shell).
// ─────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const MCP_DIR = process.env.DIFFRACT_MCP_DIR || "/var/lib/diffract/connected-mcp.d";
const NEMOCLAW_HOME = process.env.HOME || "/root";

// Resolve the default sandbox so callers that don't know the sandbox name (e.g.
// the in-sandbox Hermes dashboard's MCP panel, which reaches this host API
// same-origin via Caddy) can omit it. Reads ~/.nemoclaw/sandboxes.json.
async function defaultSandbox(): Promise<string> {
  try {
    const raw = await fs.readFile(
      path.join(NEMOCLAW_HOME, ".nemoclaw", "sandboxes.json"),
      "utf8",
    );
    const s = String(JSON.parse(raw)?.defaultSandbox || "");
    return SANDBOX_NAME_RE.test(s) ? s : "";
  } catch {
    return "";
  }
}

function syncScript(): Promise<string | null> {
  return firstExisting([
    process.env.DIFFRACT_MCP_SYNC_SCRIPT,
    "/usr/local/bin/diffract-mcp-sync.sh",
    path.resolve(process.cwd(), "..", "scripts/diffract-mcp-sync.sh"),
  ]);
}

// Detect the secret query param in an MCP URL (Zapier `?token=…`, etc.).
const SECRET_PARAM_RE = /[?&]([a-z0-9_]*(?:token|key|secret|auth|apikey)[a-z0-9_]*)=([^&#\s]+)/i;
// A request-header name for header-authenticated MCP servers (e.g. Stitch's
// `X-Goog-Api-Key`, or `Authorization`). Letters/digits/hyphens; injection-safe.
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;

async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

async function firstExisting(cands: (string | undefined)[]): Promise<string | null> {
  for (const c of cands.filter(Boolean) as string[]) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

function connectScript(): Promise<string | null> {
  return firstExisting([
    process.env.DIFFRACT_MCP_CONNECT_SCRIPT,
    "/usr/local/bin/diffract-mcp-connect.sh",
    path.resolve(process.cwd(), "..", "scripts/diffract-mcp-connect.sh"),
  ]);
}

// ── GET: list connected MCP servers (from the host-side records) ──────────
export async function GET(): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  let files: string[] = [];
  try {
    files = (await fs.readdir(MCP_DIR)).filter((f) => f.endsWith(".conf"));
  } catch {
    return Response.json({ servers: [] });
  }
  const servers = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(MCP_DIR, f), "utf8");
      const get = (k: string) => {
        const m = raw.match(new RegExp("^" + k + "=(.*)$", "m"));
        return m ? m[1].replace(/^['"]|['"]$/g, "") : "";
      };
      servers.push({ name: get("NAME"), host: get("HOST"), secretEnv: get("SECRET_ENV") });
    } catch {
      /* skip unreadable */
    }
  }
  return Response.json({ servers });
}

// ── POST: connect an MCP server ──────────────────────────────────────────
export async function POST(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  let body: {
    sandbox?: string;
    name?: string;
    url?: string;
    authHeader?: string;
    apiKey?: string;
    extraHeaders?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  let sandbox = (body.sandbox || "").trim();
  const name = (body.name || "").trim();
  const url = (body.url || "").trim();
  const authHeader = (body.authHeader || "").trim();
  const apiKey = (body.apiKey || "").trim();

  // Optional NON-SECRET extra headers (e.g. GoHighLevel's `locationId`). These are
  // identifiers, not secrets, so they go verbatim into the agent config (no provider).
  // Validate strictly to prevent header/config injection.
  const extraHeaders: Record<string, string> = {};
  if (body.extraHeaders && typeof body.extraHeaders === "object") {
    const HNAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
    for (const [k, v] of Object.entries(body.extraHeaders)) {
      const hn = String(k).trim();
      const hv = String(v ?? "").trim();
      if (!hn && !hv) continue;
      if (!HNAME_RE.test(hn)) {
        return Response.json({ error: `Invalid header name: "${hn}"` }, { status: 400 });
      }
      if (!hv || /[\r\n]/.test(hv) || hv.length > 1024) {
        return Response.json({ error: `Invalid value for header "${hn}"` }, { status: 400 });
      }
      extraHeaders[hn] = hv;
    }
  }

  // Fall back to the default sandbox when the caller didn't pass one.
  if (!sandbox) sandbox = await defaultSandbox();
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json(
      { error: "No sandbox specified and no default sandbox found — deploy an agent first" },
      { status: 400 },
    );
  }
  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid name (lowercase, a-z0-9-)" }, { status: 400 });
  }

  // Validate the URL and pull out the host. Only HTTPS MCP servers are supported
  // in this version (the proven streamable-HTTP transport).
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      return Response.json(
        { error: "Only https:// MCP servers are supported in this version" },
        { status: 400 },
      );
    }
    host = u.port ? u.host : `${u.hostname}:443`;
  } catch {
    return Response.json({ error: "Invalid MCP URL" }, { status: 400 });
  }

  // Two auth styles, both privacy-preserving (secret held host-side; the agent
  // config keeps a ${SECRET_ENV} placeholder the L7 proxy substitutes at egress):
  //   • URL-token (Zapier-style ?token=…): the secret rides in the URL.
  //   • Header (e.g. Stitch's X-Goog-Api-Key): the secret rides in a request header.
  const secretEnv = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MCP_TOKEN`;
  const m = url.match(SECRET_PARAM_RE);
  let secretValue = "";
  let placeholderUrl = url;
  let headerName = ""; // empty → URL-token mode; set → header mode

  if (m) {
    // URL-token mode: replace the token in the persisted URL with ${SECRET_ENV}.
    secretValue = m[2];
    placeholderUrl = url.replace(secretValue, "${" + secretEnv + "}");
  } else if (authHeader && apiKey) {
    // Header mode: tolerate a trailing colon ("X-Goog-Api-Key:") from the form.
    headerName = authHeader.replace(/:\s*$/, "").trim();
    if (!HEADER_NAME_RE.test(headerName)) {
      return Response.json({ error: "Invalid auth header name (e.g. X-Goog-Api-Key)" }, { status: 400 });
    }
    secretValue = apiKey;
    // The URL stays clean; the secret is injected as a header at egress.
  } else {
    return Response.json(
      {
        error:
          "Provide either an MCP URL with an embedded token (e.g. Zapier's …?token=…), or an Auth header + API key (e.g. X-Goog-Api-Key) for header-authenticated servers like Stitch.",
      },
      { status: 400 },
    );
  }

  const script = await connectScript();
  if (!script) {
    return Response.json({ error: "MCP connect script not found on host" }, { status: 500 });
  }

  // The secret flows to the script ONLY via the child env (never argv/logs).
  // Every extra header value is ALSO held host-side (nothing visible to the agent):
  // derive a provider-credential env key per header, pass each value via env under that
  // key, and pass the name->key map. The connect script stores the values in the provider
  // and writes ${KEY} placeholders into the config.
  const extraKeyMap: Record<string, string> = {};
  const extraValueEnv: Record<string, string> = {};
  const keyPrefix = `${secretEnv.replace(/_TOKEN$/, "")}_H_`;
  for (const [hn, hv] of Object.entries(extraHeaders)) {
    const key = keyPrefix + hn.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    extraKeyMap[hn] = key;
    extraValueEnv[key] = hv;
  }

  // The secret(s) flow to the script ONLY via the child env (never argv/logs).
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin`,
    [secretEnv]: secretValue,
    ...extraValueEnv,
    ...(Object.keys(extraKeyMap).length
      ? { DIFFRACT_MCP_EXTRA_KEYS: JSON.stringify(extraKeyMap) }
      : {}),
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [script, sandbox, name, placeholderUrl, secretEnv, host, headerName],
      { env: childEnv, timeout: 120000 },
    );
    // The script prints only "[mcp-connect] …" status lines, no secrets.
    return Response.json({ ok: true, output: `${stdout}\n${stderr}`.trim() });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err?.stdout || ""}\n${err?.stderr || err?.message || "connect failed"}`.trim();
    return Response.json({ ok: false, error: out }, { status: 500 });
  }
}

// ── DELETE: disconnect a connected MCP server ─────────────────────────────
// Removes the host record (so it isn't re-applied at the next create), drops it
// from the running agent config, and revokes its egress. Name via ?name=…;
// sandbox via ?sandbox=… (defaults to the default sandbox).
export async function DELETE(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const qs = new URL(req.url).searchParams;
  const name = (qs.get("name") || "").trim();
  let sandbox = (qs.get("sandbox") || "").trim();

  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid name (lowercase, a-z0-9-)" }, { status: 400 });
  }
  if (!sandbox) sandbox = await defaultSandbox();
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json(
      { error: "No sandbox specified and no default sandbox found" },
      { status: 400 },
    );
  }

  const script = await syncScript();
  if (!script) {
    return Response.json({ error: "MCP sync script not found on host" }, { status: 500 });
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [script, "remove", name, sandbox],
      {
        env: {
          ...process.env,
          PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin`,
        },
        timeout: 120000,
      },
    );
    return Response.json({ ok: true, output: `${stdout}\n${stderr}`.trim() });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err?.stdout || ""}\n${err?.stderr || err?.message || "remove failed"}`.trim();
    return Response.json({ ok: false, error: out }, { status: 500 });
  }
}
