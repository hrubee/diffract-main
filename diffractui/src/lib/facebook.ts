// Facebook / Instagram OAuth + connect helpers (dev-box, single-tenant).
//
// FLOW (see /api/facebook/login + /api/facebook/callback):
//   1. The operator clicks "Connect Facebook" → /api/facebook/login redirects to
//      Facebook's OAuth dialog (this host's /api/facebook/callback as redirect_uri).
//   2. Facebook redirects back with ?code. The callback exchanges it for a
//      long-lived USER token, then a never-expiring PAGE token, then drives the
//      EXISTING host-side-secret plumbing (diffract-tool-connect.sh) to store the
//      PAGE token in an OpenShell provider. The sandbox only ever sees the
//      ${FACEBOOK_PAGE_TOKEN} placeholder; the L7 proxy substitutes the real token
//      at egress. The agent never holds it.
//
// MULTI-TENANT NOTE: in production the redirect_uri must be ONE fixed control-plane
// URL (cp.diffraction.in), with the tenant carried in `state`. This dev-box variant
// registers this box's own callback directly — fine for one box, not for many.

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

export const GRAPH = "https://graph.facebook.com";
export const GRAPH_VERSION = "v21.0";
export const FACEBOOK_TOOL = "facebook";
export const FACEBOOK_SECRET_ENV = "FACEBOOK_PAGE_TOKEN";
export const FB_OAUTH_COOKIE = "fb_oauth";

// Permissions requested at login. Covers all four surfaces (FB comments + DMs,
// IG comments + DMs). In dev mode only app-role users can grant these; real
// customers need Meta App Review (Advanced Access) per scope.
export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_engagement",
  "pages_manage_posts",
  "pages_read_user_content",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
].join(",");

export function appId(): string | null {
  const v = process.env.FACEBOOK_APP_ID;
  return v && v.length > 0 ? v : null;
}

export function appSecret(): string | null {
  const v = process.env.FACEBOOK_APP_SECRET;
  return v && v.length > 0 ? v : null;
}

// The redirect_uri must be IDENTICAL in the login dialog and the code exchange,
// and must exactly match a "Valid OAuth Redirect URI" registered in the FB app.
// Defaults to this host's callback (Caddy always terminates TLS → https).
export function redirectUri(req: Request): string {
  const override = process.env.FACEBOOK_REDIRECT_URI;
  if (override) return override;
  const host = req.headers.get("host") || "";
  return `https://${host}/api/facebook/callback`;
}

// ── server-side Graph API calls (the HOST has normal egress; only the sandbox
// is firewalled, so these run unrestricted) ──────────────────────────────────
type GraphJson = Record<string, unknown> & { error?: { message?: string } };

export async function graphGet(pathAndQuery: string): Promise<GraphJson> {
  const res = await fetch(`${GRAPH}/${GRAPH_VERSION}/${pathAndQuery}`);
  const data = (await res.json().catch(() => ({}))) as GraphJson;
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || `Graph API error ${res.status}`);
  }
  return data;
}

// ── connect plumbing (mirror /api/tools/route.ts resolution) ─────────────────
async function firstExisting(candidates: (string | undefined)[]): Promise<string | null> {
  for (const c of candidates) {
    if (!c) continue;
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function registryPath(): Promise<string | null> {
  return firstExisting([
    process.env.DIFFRACT_TOOLS_REGISTRY,
    path.resolve(process.cwd(), "..", "NemoClaw/agents/hermes/diffract-tools.json"),
    "/usr/local/share/diffract/diffract-tools.json",
    "/root/diffract-main/NemoClaw/agents/hermes/diffract-tools.json",
  ]);
}

function connectScriptPath(): Promise<string | null> {
  return firstExisting([
    process.env.DIFFRACT_CONNECT_SCRIPT,
    "/usr/local/bin/diffract-tool-connect.sh",
    path.resolve(process.cwd(), "..", "scripts/diffract-tool-connect.sh"),
  ]);
}

// Store the page token host-side via the existing connector. The token flows to
// the script ONLY through the child env (never argv/logs); the script registers
// it in the OpenShell `facebook` provider, opens egress to the Graph hosts, and
// records the tool as connected (re-attached at the next sandbox create).
export async function connectFacebook(
  sandbox: string,
  pageToken: string,
): Promise<{ ok: boolean; output: string }> {
  const script = await connectScriptPath();
  const registry = await registryPath();
  if (!script || !registry) {
    return { ok: false, output: "Connect script or registry not found on host" };
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin`,
    [FACEBOOK_SECRET_ENV]: pageToken,
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [script, sandbox, FACEBOOK_TOOL, registry],
      { env: childEnv, timeout: 120000 },
    );
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err?.stdout || ""}\n${err?.stderr || err?.message || "connect failed"}`.trim() };
  }
}

// ── connected-state record (for the dashboard to show what's linked) ─────────
// NON-SECRET only (page name/id, ig id) — the token is never written here.
export type FacebookRecord = {
  pageId: string;
  pageName: string;
  igUserId?: string;
  igUsername?: string;
  sandbox: string;
  connectedAt: string;
};

function recordFile(): string {
  return process.env.DIFFRACT_FACEBOOK_RECORD || "/var/lib/diffract/facebook.json";
}

export async function writeFacebookRecord(rec: FacebookRecord): Promise<void> {
  const f = recordFile();
  await fs.mkdir(path.dirname(f), { recursive: true }).catch(() => {});
  await fs.writeFile(f, JSON.stringify(rec, null, 2), { mode: 0o600 });
}

export async function readFacebookRecord(): Promise<FacebookRecord | null> {
  try {
    return JSON.parse(await fs.readFile(recordFile(), "utf8")) as FacebookRecord;
  } catch {
    return null;
  }
}
