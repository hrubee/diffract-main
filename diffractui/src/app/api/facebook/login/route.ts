export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import {
  appId,
  redirectUri,
  FACEBOOK_SCOPES,
  FB_OAUTH_COOKIE,
  GRAPH_VERSION,
} from "@/lib/facebook";

const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// GET /api/facebook/login?sandbox=<name>
// Starts the Facebook OAuth dance: stash a CSRF nonce + the target sandbox in an
// httpOnly cookie, then redirect the operator to Facebook's consent dialog.
export async function GET(req: Request): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sandbox = searchParams.get("sandbox") || "";
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return NextResponse.json({ error: "Invalid or missing sandbox name" }, { status: 400 });
  }

  const id = appId();
  if (!id) {
    return new Response(
      "Facebook is not configured. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in /etc/diffractui.env and restart the dashboard.",
      { status: 500, headers: { "content-type": "text/plain" } },
    );
  }

  // CSRF: random nonce echoed back by Facebook as `state`; we also carry the
  // sandbox name through the round-trip in the same httpOnly cookie.
  const state = crypto.randomUUID().replace(/-/g, "");
  const redirect = redirectUri(req);

  const dialog =
    `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth` +
    `?client_id=${encodeURIComponent(id)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(FACEBOOK_SCOPES)}`;

  const res = NextResponse.redirect(dialog);
  res.cookies.set(FB_OAUTH_COOKIE, JSON.stringify({ state, sandbox }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 min to complete the flow
  });
  return res;
}
