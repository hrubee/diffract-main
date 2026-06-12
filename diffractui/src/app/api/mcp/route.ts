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
// SECURITY MODEL (same as api/tools/route.ts): admin-session gated; the server's
// secret (the token embedded in its URL) is extracted here, passed to the connect
// script ONLY via the child env (never argv, never logged, never returned), and
// stored host-side in an OpenShell provider. The URL persisted in the agent config
// holds only a `${SECRET_ENV}` placeholder; the L7 proxy substitutes the real
// value at egress. execFile uses argv arrays (no shell).
// ─────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const MCP_DIR = process.env.DIFFRACT_MCP_DIR || "/var/lib/diffract/connected-mcp.d";

// Detect the secret query param in an MCP URL (Zapier `?token=…`, etc.).
const SECRET_PARAM_RE = /[?&]([a-z0-9_]*(?:token|key|secret|auth|apikey)[a-z0-9_]*)=([^&#\s]+)/i;

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

  let body: { sandbox?: string; name?: string; url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sandbox = body.sandbox || "";
  const name = (body.name || "").trim();
  const url = (body.url || "").trim();

  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json({ error: "Invalid sandbox name" }, { status: 400 });
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

  // Extract the secret token embedded in the URL (Zapier-style ?token=…) so it
  // can be held host-side. The URL we persist replaces it with ${SECRET_ENV}.
  const m = url.match(SECRET_PARAM_RE);
  if (!m) {
    return Response.json(
      {
        error:
          "No token found in the URL. This version supports MCP servers whose URL embeds a token (e.g. Zapier's …?token=…).",
      },
      { status: 400 },
    );
  }
  const tokenValue = m[2];
  const secretEnv = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MCP_TOKEN`;
  const placeholderUrl = url.replace(tokenValue, "${" + secretEnv + "}");

  const script = await connectScript();
  if (!script) {
    return Response.json({ error: "MCP connect script not found on host" }, { status: 500 });
  }

  // The secret flows to the script ONLY via the child env (never argv/logs).
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin`,
    [secretEnv]: tokenValue,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [script, sandbox, name, placeholderUrl, secretEnv, host],
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
