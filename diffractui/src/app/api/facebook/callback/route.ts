export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import {
  appId,
  appSecret,
  redirectUri,
  graphGet,
  connectFacebook,
  writeFacebookRecord,
  FB_OAUTH_COOKIE,
} from "@/lib/facebook";

const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function dashboard(req: Request, params: Record<string, string>): string {
  const host = req.headers.get("host") || "";
  const qs = new URLSearchParams(params).toString();
  return `https://${host}/?${qs}`;
}

function clearOauthCookie(res: NextResponse): void {
  res.cookies.set(FB_OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
}

// GET /api/facebook/callback?code=…&state=…  (Facebook redirects here)
// Exchanges the code for a never-expiring Page token and wires it host-side via
// the existing connector. On any failure, bounces back to the dashboard with a
// ?facebook_error= reason rather than leaking a stack trace.
export async function GET(req: Request): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code") || "";
  const state = searchParams.get("state") || "";
  const oauthError = searchParams.get("error");

  // Recover the CSRF nonce + target sandbox stashed at /login.
  let cookieState = "";
  let sandbox = "";
  try {
    const raw = (await cookies()).get(FB_OAUTH_COOKIE)?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      cookieState = String(parsed.state || "");
      sandbox = String(parsed.sandbox || "");
    }
  } catch {
    /* fall through to validation errors below */
  }

  // User declined the consent dialog.
  if (oauthError) {
    const res = NextResponse.redirect(dashboard(req, { facebook_error: "denied" }));
    clearOauthCookie(res);
    return res;
  }

  // CSRF + integrity checks.
  if (!code || !state || !cookieState || state !== cookieState) {
    const res = NextResponse.redirect(dashboard(req, { facebook_error: "state" }));
    clearOauthCookie(res);
    return res;
  }
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    const res = NextResponse.redirect(dashboard(req, { facebook_error: "sandbox" }));
    clearOauthCookie(res);
    return res;
  }

  const id = appId();
  const secret = appSecret();
  if (!id || !secret) {
    const res = NextResponse.redirect(dashboard(req, { facebook_error: "not_configured" }));
    clearOauthCookie(res);
    return res;
  }

  try {
    const redirect = redirectUri(req);

    // 1. code → short-lived user token
    const shortTok = await graphGet(
      `oauth/access_token?client_id=${encodeURIComponent(id)}` +
        `&client_secret=${encodeURIComponent(secret)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}` +
        `&code=${encodeURIComponent(code)}`,
    );
    const shortToken = String(shortTok.access_token || "");
    if (!shortToken) throw new Error("no short-lived token");

    // 2. short-lived → long-lived user token (~60d)
    const longTok = await graphGet(
      `oauth/access_token?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(id)}` +
        `&client_secret=${encodeURIComponent(secret)}` +
        `&fb_exchange_token=${encodeURIComponent(shortToken)}`,
    );
    const longToken = String(longTok.access_token || "");
    if (!longToken) throw new Error("no long-lived token");

    // 3. long-lived user token → PAGE token (never-expiring). Pick the page named
    //    by FACEBOOK_PAGE_ID if set, else the first page.
    const accounts = await graphGet(
      `me/accounts?fields=name,id,access_token&access_token=${encodeURIComponent(longToken)}`,
    );
    const pages = (accounts.data as Array<Record<string, string>>) || [];
    if (!pages.length) throw new Error("no_pages");
    const wantId = process.env.FACEBOOK_PAGE_ID;
    const page = (wantId && pages.find((p) => p.id === wantId)) || pages[0];
    const pageId = String(page.id);
    const pageName = String(page.name || pageId);
    const pageToken = String(page.access_token || "");
    if (!pageToken) throw new Error("no page token");

    // 4. (best-effort) linked Instagram business account
    let igUserId: string | undefined;
    let igUsername: string | undefined;
    try {
      const ig = await graphGet(
        `${encodeURIComponent(pageId)}?fields=instagram_business_account{id,username}` +
          `&access_token=${encodeURIComponent(pageToken)}`,
      );
      const acct = ig.instagram_business_account as { id?: string; username?: string } | undefined;
      if (acct?.id) {
        igUserId = acct.id;
        igUsername = acct.username;
      }
    } catch {
      /* IG not linked — fine */
    }

    // 5. Store the PAGE token host-side via the existing connector (placeholder in
    //    the sandbox; real value substituted at egress). The agent never sees it.
    const connected = await connectFacebook(sandbox, pageToken);
    if (!connected.ok) {
      const res = NextResponse.redirect(dashboard(req, { facebook_error: "connect" }));
      clearOauthCookie(res);
      return res;
    }

    // 6. Record the NON-SECRET connected state for the dashboard.
    await writeFacebookRecord({
      pageId,
      pageName,
      igUserId,
      igUsername,
      sandbox,
      connectedAt: new Date().toISOString(),
    }).catch(() => {});

    const res = NextResponse.redirect(
      dashboard(req, { connected: "facebook", page: pageName }),
    );
    clearOauthCookie(res);
    return res;
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message === "no_pages" ? "no_pages" : "exchange";
    const res = NextResponse.redirect(dashboard(req, { facebook_error: msg }));
    clearOauthCookie(res);
    return res;
  }
}
