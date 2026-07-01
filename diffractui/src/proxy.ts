// Next.js 16 "proxy" (formerly middleware) — gates the Diffract control
// surface behind the Phase-0 admin session. See src/lib/auth.ts.
//
// Browser page requests without a valid session are redirected to /login;
// /api/* requests get a 401. If auth isn't configured, we fail CLOSED.
// Defense-in-depth: the most dangerous Route Handlers re-check the session
// themselves (the Next docs warn against relying on proxy matching alone).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken, authConfigured } from "@/lib/auth";

export const config = {
  // Gate everything except Next internals, the login page, the auth API, and
  // api/authz (the Caddy forward_auth endpoint, which returns its own 302/403/200).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth|api/authz).*)"],
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api");

  // Fail closed: with no admin password / signing secret configured, deny.
  if (!authConfigured()) {
    if (isApi) {
      return NextResponse.json(
        { error: "Auth not configured. Set DIFFRACT_ADMIN_PASSWORD and DIFFRACT_AUTH_SECRET." },
        { status: 503 },
      );
    }
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "unconfigured");
    return NextResponse.redirect(url);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  if (isApi) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL("/login", request.url);
  if (pathname && pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}
